import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

from backend.app import documents
from backend.app.config import Settings
from backend.app.documents import (
    NeedsManualReview,
    RendererUnavailable,
    UnreadableDocument,
    UnsupportedFile,
    parse_cv,
    prepare_evaluation_spans,
)
from backend.app.schemas import EvidenceSpan
from backend.tests.factories import (
    write_docx,
    write_multipage_pdf,
    write_pdf,
)


@pytest.fixture
def test_settings(tmp_path, monkeypatch):
    settings = Settings(_env_file=None, data_dir=tmp_path / "data")
    monkeypatch.setattr(documents, "get_settings", lambda: settings)
    return settings


CV_TEXT = (
    "Alex Example\n"
    "email: alex@example.com | phone: +44 20 7946 0958\n"
    "Built Python REST APIs and PostgreSQL services for three years."
)


def test_pdf_spans_have_one_based_pages_and_verbatim_text(tmp_path, test_settings):
    source = tmp_path / "stored-uuid"
    write_multipage_pdf(source, ["Page one content.", "Page two content."])
    parsed = parse_cv(source, "candidate.pdf")
    assert parsed.preview_path == source
    assert len(parsed.spans) >= 2
    pages = {span.page_number for span in parsed.spans}
    assert min(pages) == 1
    assert 2 in pages
    assert all(isinstance(span, EvidenceSpan) for span in parsed.spans)
    assert all(span.id for span in parsed.spans)
    texts = " ".join(span.text for span in parsed.spans)
    assert "Page one content." in texts
    assert "Page two content." in texts


def test_evaluation_view_masks_contact_lines_but_source_preserves_them(
    tmp_path, test_settings
):
    source = tmp_path / "stored-uuid"
    write_pdf(source, CV_TEXT)
    parsed = parse_cv(source, "candidate.pdf")
    source_text = " ".join(span.text for span in parsed.spans)
    assert "alex@example.com" in source_text
    evaluation_spans = prepare_evaluation_spans(parsed.spans)
    evaluation_text = " ".join(span.text for span in evaluation_spans)
    assert "alex@example.com" not in evaluation_text
    assert "7946" not in evaluation_text
    assert "Python REST APIs" in evaluation_text
    assert all(isinstance(span.id, str) for span in evaluation_spans)


def test_unknown_extension_is_rejected(tmp_path, test_settings):
    source = tmp_path / "stored-uuid"
    source.write_bytes(b"plain text")
    with pytest.raises(UnsupportedFile):
        parse_cv(source, "notes.txt")


def test_invalid_pdf_signature_is_rejected(tmp_path, test_settings):
    source = tmp_path / "stored-uuid"
    source.write_bytes(b"not a PDF at all")
    with pytest.raises(UnsupportedFile):
        parse_cv(source, "candidate.pdf")


def test_image_only_pdf_needs_manual_review(tmp_path, test_settings):
    source = tmp_path / "stored-uuid"
    write_pdf(source, "")
    with pytest.raises(NeedsManualReview):
        parse_cv(source, "scanned.pdf")


def test_corrupt_docx_is_rejected(tmp_path, test_settings):
    source = tmp_path / "stored-uuid"
    source.write_bytes(b"definitely not a zip")
    with pytest.raises(UnsupportedFile):
        parse_cv(source, "cv.docx")


def test_zip_that_is_not_docx_is_rejected(tmp_path, test_settings):
    source = tmp_path / "stored-uuid"
    with zipfile.ZipFile(source, "w") as archive:
        archive.writestr("readme.txt", "hello")
    with pytest.raises(UnsupportedFile):
        parse_cv(source, "cv.docx")


def test_oversized_file_is_rejected(tmp_path, test_settings):
    test_settings.max_file_bytes = 64
    source = tmp_path / "stored-uuid"
    source.write_bytes(b"%PDF-" + b"x" * 200)
    with pytest.raises(UnsupportedFile):
        parse_cv(source, "big.pdf")


def test_missing_renderer_raises_typed_error(tmp_path, test_settings, monkeypatch):
    source = tmp_path / "stored-uuid"
    write_docx(source, "Some CV text")
    monkeypatch.setattr(documents.shutil, "which", lambda name: None)
    with pytest.raises(RendererUnavailable):
        parse_cv(source, "cv.docx")


def test_conversion_timeout_is_unreadable(tmp_path, test_settings, monkeypatch):
    source = tmp_path / "stored-uuid"
    write_docx(source, "Some CV text")
    monkeypatch.setattr(documents.shutil, "which", lambda name: "/usr/bin/soffice")

    def slow_run(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd="soffice", timeout=60)

    monkeypatch.setattr(documents.subprocess, "run", slow_run)
    with pytest.raises(UnreadableDocument):
        parse_cv(source, "cv.docx")


def test_failed_conversion_output_is_unreadable(
    tmp_path, test_settings, monkeypatch
):
    source = tmp_path / "stored-uuid"
    write_docx(source, "Some CV text")
    monkeypatch.setattr(documents.shutil, "which", lambda name: "/usr/bin/soffice")

    def no_output(*args, **kwargs):
        return subprocess.CompletedProcess(args=args, returncode=0)

    monkeypatch.setattr(documents.subprocess, "run", no_output)
    with pytest.raises(UnreadableDocument):
        parse_cv(source, "cv.docx")


@pytest.mark.skipif(
    shutil.which("soffice") is None, reason="LibreOffice is not installed"
)
def test_docx_converts_to_page_linked_preview(tmp_path, test_settings):
    source = tmp_path / "stored-uuid"
    write_docx(source, "Docx body: Python backend services.")
    parsed = parse_cv(source, "cv.docx")
    assert parsed.preview_path.suffix == ".pdf"
    assert parsed.preview_path.exists()
    assert parsed.preview_path != source
    assert parsed.spans
    assert parsed.spans[0].page_number == 1
    assert "Python backend services" in " ".join(
        span.text for span in parsed.spans
    )

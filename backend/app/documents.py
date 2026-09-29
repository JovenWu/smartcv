import re
import shutil
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path

import pymupdf

from backend.app.config import get_settings
from backend.app.schemas import EvaluationSpan, EvidenceSpan

_ALLOWED_SUFFIXES = {".pdf", ".docx"}
_CONVERT_TIMEOUT_SECONDS = 60


class DocumentError(Exception):
    """Base class for typed per-file parse failures."""


class UnsupportedFile(DocumentError):
    """Extension, signature, or size is not supported. Not retryable."""


class UnreadableDocument(DocumentError):
    """The file looks supported but cannot be parsed. Not retryable."""


class NeedsManualReview(DocumentError):
    """The file parsed but produced no usable text (for example, scans)."""


class RendererUnavailable(DocumentError):
    """DOCX normalization needs LibreOffice, which is missing. Retryable."""


@dataclass(frozen=True)
class ParsedDocument:
    preview_path: Path
    spans: list[EvidenceSpan]


def validate_upload(
    path: Path, original_filename: str, max_bytes: int
) -> str:
    """Check extension, size, and file signature. Returns the suffix."""
    suffix = Path(original_filename).suffix.lower()
    if suffix not in _ALLOWED_SUFFIXES:
        raise UnsupportedFile(
            f"Unsupported file type '{suffix or '(none)'}'; upload PDF or DOCX"
        )
    if path.stat().st_size > max_bytes:
        raise UnsupportedFile(f"File exceeds the {max_bytes} byte limit")
    if suffix == ".pdf":
        _require_pdf_signature(path)
    else:
        _require_docx_structure(path)
    return suffix


def parse_cv(path: Path, original_filename: str) -> ParsedDocument:
    settings = get_settings()
    suffix = validate_upload(path, original_filename, settings.max_file_bytes)
    if suffix == ".pdf":
        preview_path = path
    else:
        preview_path = _convert_docx_to_pdf(path, settings.previews_dir)
    return ParsedDocument(
        preview_path=preview_path, spans=extract_pdf_spans(preview_path)
    )


def _require_pdf_signature(path: Path) -> None:
    with open(path, "rb") as handle:
        header = handle.read(1024)
    if b"%PDF-" not in header:
        raise UnsupportedFile("File is not a valid PDF")


def _require_docx_structure(path: Path) -> None:
    if not zipfile.is_zipfile(path):
        raise UnsupportedFile("File is not a valid DOCX")
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
    except zipfile.BadZipFile as error:
        raise UnsupportedFile("File is not a valid DOCX") from error
    if "word/document.xml" not in names:
        raise UnsupportedFile("File is not a valid DOCX")


def extract_pdf_spans(path: Path) -> list[EvidenceSpan]:
    spans: list[EvidenceSpan] = []
    try:
        with pymupdf.open(path) as document:
            for page_number, page in enumerate(document, start=1):
                blocks = page.get_text("blocks", sort=True)
                for block_number, block in enumerate(blocks):
                    text = block[4].strip()
                    if text:
                        spans.append(
                            EvidenceSpan(
                                id=f"p{page_number}-b{block_number}",
                                page_number=page_number,
                                text=text,
                            )
                        )
    except NeedsManualReview:
        raise
    except Exception as error:
        raise UnreadableDocument("The PDF could not be read") from error
    if not spans:
        raise NeedsManualReview(
            "No selectable text; OCR is not supported in the MVP"
        )
    return spans


def _convert_docx_to_pdf(source_path: Path, previews_dir: Path) -> Path:
    soffice = shutil.which("soffice")
    if soffice is None:
        raise RendererUnavailable(
            "DOCX support needs LibreOffice (soffice) on the server"
        )
    previews_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        profile_dir = temp_dir / "lo-profile"
        profile_dir.mkdir()
        try:
            subprocess.run(
                [
                    soffice,
                    f"-env:UserInstallation={profile_dir.as_uri()}",
                    "--headless",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    str(temp_dir),
                    str(source_path),
                ],
                check=True,
                timeout=_CONVERT_TIMEOUT_SECONDS,
                capture_output=True,
            )
        except subprocess.TimeoutExpired as error:
            raise UnreadableDocument(
                "DOCX conversion timed out"
            ) from error
        except subprocess.CalledProcessError as error:
            raise UnreadableDocument(
                "DOCX conversion failed"
            ) from error
        produced = temp_dir / f"{source_path.stem}.pdf"
        if not produced.exists():
            raise UnreadableDocument("DOCX conversion produced no output")
        destination = previews_dir / f"{source_path.stem}.pdf"
        shutil.move(str(produced), destination)
    return destination


_EMAIL = re.compile(r"\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b")
_PHONE = re.compile(r"(?<!\w)\+?[\d]{2,4}(?:[\s().-]+\d{3,4}){2,3}(?!\w)")
_PERSONAL_LINE = re.compile(
    r"(?im)^\s*(?:name|email|phone|mobile|address|date of birth)\s*[:|].*$"
)


def prepare_evaluation_spans(spans: list[EvidenceSpan]) -> list[EvaluationSpan]:
    evaluation_spans = []
    for span in spans:
        text = _PERSONAL_LINE.sub("", span.text)
        text = _EMAIL.sub("[redacted]", text)
        text = _PHONE.sub("[redacted]", text)
        if text.strip():
            evaluation_spans.append(
                EvaluationSpan(
                    id=span.id,
                    page_number=span.page_number,
                    text=text.strip(),
                )
            )
    return evaluation_spans

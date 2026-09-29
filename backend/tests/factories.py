from pathlib import Path

import pymupdf
from docx import Document

from backend.app.schemas import Criterion


def write_pdf(path: Path, text: str) -> None:
    document = pymupdf.open()
    page = document.new_page()
    if text:
        page.insert_text((72, 72), text)
    document.save(path)
    document.close()


def write_multipage_pdf(path: Path, pages: list[str]) -> None:
    document = pymupdf.open()
    for text in pages:
        page = document.new_page()
        if text:
            page.insert_text((72, 72), text)
    document.save(path)
    document.close()


def write_docx(path: Path, text: str) -> None:
    document = Document()
    document.add_paragraph(text)
    document.save(path)


def make_criteria() -> list[Criterion]:
    return [
        Criterion(
            id="python",
            name="Python",
            description="Build Python backend services.",
            weight=5,
        ),
        Criterion(
            id="production",
            name="Production experience",
            description="Show professional production-service experience.",
            weight=4,
        ),
        Criterion(
            id="postgresql",
            name="PostgreSQL",
            description="Use PostgreSQL in backend services.",
            weight=3,
        ),
    ]

"""Generate a synthetic demo batch under backend/data/demo/.

All CVs are synthetic. No real names, employers, or applicant data.
"""

import json
from pathlib import Path

import pymupdf
from docx import Document

OUTPUT_DIR = Path(__file__).resolve().parents[1] / "data" / "demo"

SCENARIOS = [
    "Built Python REST APIs and PostgreSQL services for three years.",
    "Developed server-side services in Python with relational databases.",
    "Used Python in a university project; no production API experience stated.",
    "Worked in customer support; no programming evidence appears in this CV.",
    "Lists Python and backend development, but gives no dates or project details.",
]

DEMO_JOB = {
    "title": "Backend Engineer",
    "criteria": [
        {
            "id": "python",
            "name": "Python",
            "description": "Build Python backend services.",
            "weight": 5,
        },
        {
            "id": "production",
            "name": "Production experience",
            "description": "Show professional production-service experience.",
            "weight": 4,
        },
        {
            "id": "postgresql",
            "name": "PostgreSQL",
            "description": "Use PostgreSQL in backend services.",
            "weight": 3,
        },
    ],
}


def write_pdf(path: Path, text: str) -> None:
    document = pymupdf.open()
    page = document.new_page()
    if text:
        page.insert_text((72, 72), text)
    document.save(path)
    document.close()


def write_docx(path: Path, text: str) -> None:
    document = Document()
    document.add_paragraph(text)
    document.save(path)


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIR / "opening.json").write_text(
        json.dumps(DEMO_JOB, indent=2), encoding="utf-8"
    )
    for index in range(25):
        pdf_path = OUTPUT_DIR / f"synthetic-{index:02}.pdf"
        if index < 20:
            text = SCENARIOS[index % len(SCENARIOS)]
            if index % 2 == 0:
                write_pdf(pdf_path, text)
            else:
                write_docx(pdf_path.with_suffix(".docx"), text)
        elif index < 23:
            write_pdf(pdf_path, "")
        else:
            pdf_path.write_bytes(b"not a PDF")
    print(f"Wrote demo batch to {OUTPUT_DIR}")


if __name__ == "__main__":
    main()

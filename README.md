# SmartCV

Demo-only CV screening workflow. A FastAPI backend parses PDF/DOCX CVs into
page-linked evidence spans, asks Jev (TypeSafe System One) for per-criterion
judgments, computes a transparent weighted score in code, and streams each
completed scorecard over SSE. The recruiter always makes shortlist decisions;
the system never rejects or contacts candidates.

**Demo scope:** synthetic or rigorously de-identified CVs only. No real
applicant data, no OCR, no automatic rejection.

## Prerequisites

- Python 3.13 (`py -3.13` on Windows)
- LibreOffice (`soffice` on PATH) — required only to process `.docx` uploads;
  PDF-only workflows run without it
- `TYPESAFE_API_KEY` for live Jev evaluations — or set
  `SMARTCV_FAKE_EVALUATOR=true` for an explicit synthetic demo

## Setup

```bash
py -3.13 -m venv backend/.venv
backend/.venv/Scripts/python -m pip install -r backend/requirements.txt
cp .env.example backend/.env   # fill in TYPESAFE_API_KEY for live mode
```

## Run

```bash
backend/.venv/Scripts/python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

The server binds to localhost only. `GET /api/health` returns `{"status":"ok"}`.

## Test

```bash
backend/.venv/Scripts/python -m pytest backend/tests -q
```

All automated tests use synthetic documents and a fake evaluator; no live API
key is needed.

## Synthetic demo batch

```bash
backend/.venv/Scripts/python backend/scripts/generate_demo_batch.py
```

Writes 25 synthetic PDF/DOCX/corrupt CVs plus a `job.json` under the ignored
`backend/data/demo/` directory.

## Notes

- `backend/data/` holds uploaded files, normalized previews, and the SQLite
  database, and is git-ignored.
- `SMARTCV_FAKE_EVALUATOR=true` must be set explicitly; provider failures never
  switch to fake scoring silently.
- `REVIEW_CONFIDENCE_THRESHOLD` only adds a review flag; it never hides or
  rejects a candidate. Calibrate it on the demo set before trusting it.

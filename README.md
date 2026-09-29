# SmartCV

Demo-only CV screening workflow. A FastAPI backend parses PDF/DOCX CVs into
page-linked evidence spans, asks Jev (TypeSafe System One) for per-criterion
judgments, computes a transparent weighted score in code, and streams each
completed scorecard over SSE. The recruiter always makes shortlist decisions;
the system never rejects or contacts candidates.

**Demo scope:** synthetic or rigorously de-identified CVs only. No real
applicant data, no OCR, no automatic rejection.

## Run with Docker (recommended)

Docker is the only supported way to run the full stack: the image ships Python
3.13 plus LibreOffice, which the `.docx` normalization needs.

```bash
docker compose up --build
```

The API listens on `http://127.0.0.1:8000` (localhost-only port binding).
`GET /api/health` returns `{"status":"ok"}`. Uploaded files, normalized
previews, and the SQLite database persist in the `smartcv-data` volume.

By default the container runs with `SMARTCV_FAKE_EVALUATOR=true`, a
deterministic offline evaluator for synthetic demo data. For live Jev
evaluations, put `TYPESAFE_API_KEY` in `backend/.env` (never commit it) or pass
it as an environment variable, and set `SMARTCV_FAKE_EVALUATOR=false`:

```bash
SMARTCV_FAKE_EVALUATOR=false TYPESAFE_API_KEY=<key> docker compose up --build
```

Provider failures never fall back to fake scoring silently.

Run the test suite inside the image:

```bash
docker compose run --rm backend python -m pytest backend/tests -q
```

## Local development (optional)

Requires Python 3.13 (`py -3.13` on Windows). Without LibreOffice on PATH,
`.docx` uploads fail as retryable errors; PDFs work fine.

```bash
py -3.13 -m venv backend/.venv
backend/.venv/Scripts/python -m pip install -r backend/requirements.txt
cp .env.example backend/.env   # fill in TYPESAFE_API_KEY for live mode

backend/.venv/Scripts/python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
backend/.venv/Scripts/python -m pytest backend/tests -q
```

## Synthetic demo batch

```bash
backend/.venv/Scripts/python backend/scripts/generate_demo_batch.py
```

Writes 25 synthetic PDF/DOCX/corrupt CVs plus a `job.json` under the ignored
`backend/data/demo/` directory. Upload them through
`POST /api/jobs/{job_id}/cvs` after creating a job from `job.json`.

## API overview

- `POST /api/weight-suggestions` — Jev weight suggestions (recruiter confirms)
- `POST /api/jobs` — create a job with confirmed criteria/weights
- `POST /api/jobs/{id}/cvs` — multipart batch upload (≤200 files)
- `GET /api/jobs/{id}` — snapshot of job, candidates, scores
- `GET /api/jobs/{id}/events` — SSE: `snapshot`, `candidate.updated`,
  `job.progress`, `job.complete`
- `GET /api/jobs/{id}/candidates/{cid}/preview` — normalized PDF preview
- `GET /api/jobs/{id}/candidates/{cid}/spans` — extracted evidence spans
- `PATCH /api/jobs/{id}/candidates/{cid}/criteria/{criterion_id}` — manual
  review override (`not_found`/`partial`/`strong` + note)
- `POST /api/jobs/{id}/candidates/{cid}/retry` — retry a retryable failure

## Notes

- `REVIEW_CONFIDENCE_THRESHOLD` only adds a review flag; it never hides or
  rejects a candidate. Calibrate it on the demo set before trusting it.
- Raw CV text and TypeSafe request/response bodies are never logged; the
  `typesafe_sdk` logger is pinned to WARNING.

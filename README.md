# SmartCV

Demo-only CV screening workflow. Recruiters create **openings** — manually or
by importing a listing from a job board link or a dropped file — then upload
PDF/DOCX CVs. A FastAPI backend parses each CV into page-linked evidence
spans, asks Jev (TypeSafe System One) for per-criterion judgments, computes a
transparent weighted score in code, and streams each completed scorecard over
SSE. A LangGraph import agent (OpenRouter `openai/gpt-6-luna`, optional Tavily
web-search fallback) extracts role details and criteria from listings for
reviewer confirmation. The recruiter always makes shortlist decisions; the
system never rejects or contacts candidates.

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

### Listing import (optional)

The "Import a listing" flow (paste a Jobstreet/LinkedIn/Glints link or drop a
PDF, DOCX, or image of the ad) needs an OpenRouter key; Tavily adds a
web-search fallback for blocked or thin pages:

```bash
OPENROUTER_API_KEY=<key> TAVILY_API_KEY=<key> docker compose up --build
```

`OPENROUTER_MODEL` defaults to `openai/gpt-6-luna`. Without keys the import
endpoints return 503; set `SMARTCV_FAKE_IMPORTER=true` for a deterministic
offline stub. The draft is never persisted — the reviewer confirms it in the
review form first. API keys stay server-side.

While typing skills in the manual form, the UI debounces ~600ms then asks
`POST /api/criteria-suggestions` for Jev classifications — matching existing
criteria or proposing new weighted ones.

### Demo gate (optional)

Set `SMARTCV_ACCOUNTS` to a JSON map of usernames and passwords to put the
whole API behind a login page:

```bash
SMARTCV_ACCOUNTS='{"recruiter": "s3cret", "guest": "demo123"}' docker compose up --build
```

or add the same line to `backend/.env`. Successful login sets an HttpOnly
session cookie (12h, SameSite=Lax); every `/api/*` route — including the SSE
stream and CV previews — returns 401 without it. Sessions are in-memory, so a
container restart signs everyone out. Leave the variable unset/empty to run
ungated for local dev and tests. This is demo-grade gating, not production
authentication.

Run the test suite inside the image:

```bash
docker compose run --rm backend python -m pytest backend/tests -q
```

## Frontend

React/Vite UI in `frontend/` — the full workflow in one screen: define role
criteria, review suggested weights, confirm, upload a batch, watch scorecards
stream in live, then inspect evidence and apply manual overrides.

```bash
cd frontend
npm install --legacy-peer-deps
npm run dev        # http://localhost:5173, proxies /api to :8000
npm run test -- --run
npm run build
```

Start the backend first (`docker compose up`). The dev server proxies all
`/api/*` calls — including the SSE stream — to the container, so no CORS or
secrets configuration is needed. `TYPESAFE_API_KEY` stays server-side only.

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

Writes 25 synthetic PDF/DOCX/corrupt CVs plus an `opening.json` under the
ignored `backend/data/demo/` directory. Create the opening via
`POST /api/openings` with that body, then upload the CVs through
`POST /api/openings/{id}/candidates`.

## API overview

- `GET/POST /api/openings` — list / create openings (criteria carry
  recruiter-confirmed weights plus `suggestedWeight`/`suggestionConfidence`)
- `GET/PATCH /api/openings/{id}` — detail / edit an opening
- `POST /api/openings/import/link` — extract a listing draft from a URL
  (503 without `OPENROUTER_API_KEY`/`SMARTCV_FAKE_IMPORTER`)
- `POST /api/openings/import/file` — extract a listing draft from a
  PDF/DOCX/image upload (multipart `file`)
- `POST /api/criteria-suggestions` — debounced skill → criterion
  classification (matched criterion or a new weighted suggestion)
- `POST /api/weight-suggestions` — Jev weight suggestions (recruiter confirms)
- `POST /api/openings/{id}/candidates` — multipart CV batch (≤200 files,
  PDF/DOCX only)
- `GET /api/openings/{id}/candidates` — candidate list for one opening
- `GET /api/openings/{id}/events` — SSE: `snapshot`, `candidate.updated`,
  `opening.progress`, `opening.complete`
- `GET /api/openings/{id}/candidates/{cid}/preview` — normalized PDF preview
- `GET /api/openings/{id}/candidates/{cid}/spans` — extracted evidence spans
- `PATCH /api/openings/{id}/candidates/{cid}/criteria/{criterion_id}` — manual
  review override (`not_found`/`partial`/`strong` + note)
- `PATCH /api/openings/{id}/candidates/{cid}/decision` — recruiter decision
  (`undecided`/`shortlisted`/`passed`)
- `POST /api/openings/{id}/candidates/{cid}/retry` — retry a retryable failure

## Notes

- `REVIEW_CONFIDENCE_THRESHOLD` only adds a review flag; it never hides or
  rejects a candidate. Calibrate it on the demo set before trusting it.
- Raw CV text and TypeSafe request/response bodies are never logged; the
  `typesafe_sdk` logger is pinned to WARNING.

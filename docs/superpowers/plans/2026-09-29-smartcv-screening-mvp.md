# SmartCV Screening MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a demo-only CV screening workflow that scores each candidate against recruiter-confirmed job criteria, streams completed scorecards into a live dashboard, and leaves shortlist decisions with the recruiter.

**Architecture:** A FastAPI backend owns jobs, uploads, document parsing, Jev requests, score calculation, persistence, and server-sent events. A bounded in-process async worker pool processes each CV independently and stores results in SQLite. A React/Vite/TypeScript frontend creates the job, uploads batches, receives SSE updates, and renders provisional rankings and source evidence. This is a local demo architecture, not a production deployment.

**Tech Stack:** Python 3.13 (available as `py -3.13`), FastAPI, Uvicorn, SQLite via `aiosqlite`, TypeSafe Python SDK with `AsyncTypeSafeClient`, PyMuPDF, LibreOffice headless conversion for DOCX page references, React 19.3.0, Vite 8.3.0, TypeScript 7.0.2, Vitest 4.1.0, and native browser `EventSource`. Node 24.14.0 and npm 11.4.2 are available. `soffice` is not installed and must be installed before DOCX conversion can be verified.

**Spec:** `docs/superpowers/specs/2026-09-29-smartcv-screening-design.md`

## Global Constraints

- Use synthetic or rigorously de-identified CVs only; do not use identifiable applicant data in the demo.
- Accept PDF and DOCX; scanned/image-only documents receive a manual-attention status; do not add OCR.
- Jev may suggest criterion weights, but recruiters must confirm them before scoring.
- Every criterion contributes to a transparent weighted score; no automatic hard-gate exclusion, rejection, or candidate communication.
- “Not found” means no evidence appeared in the CV and earns zero; it does not establish that the candidate lacks the qualification.
- Keep low-confidence and inconsistent results visible for review; confidence must never hide or reject a candidate.
- Show only verbatim source evidence with a verified page location; never present a generated quote as a citation.
- Restrict evaluation to explicit, job-related criteria; do not infer or score protected/demographic traits.
- Omit candidate display names and contact fields from Jev state; mask email/phone patterns while retaining original source text only for verified citations.
- Keep `TYPESAFE_API_KEY` on the backend. Do not log CV text, TypeSafe request/response bodies, or secrets.
- Pin dependencies to exact versions; select stable releases at least seven days old and commit lock files.
- Bind the demo server to localhost and keep runtime files/database out of Git.
- Commit messages must not contain agent/tool attribution, co-author trailers, or generated-by footers.

---

## Scope and repository structure

This is one end-to-end MVP plan. The parser, scoring service, worker, SSE contract, and dashboard are coupled through the `Job → Candidate → CriterionEvaluation` flow, so splitting them into separate product plans would delay the first testable vertical slice.

| File or directory | Responsibility |
|---|---|
| `.gitignore` | Exclude virtual environments, `.env`, SQLite files, uploaded CVs, normalized previews, Node modules, and build output. |
| `.env.example` | Document blank backend-only configuration names without containing credentials. |
| `README.md` | Local prerequisites, setup, run, test, and synthetic-data demo instructions. |
| `backend/requirements.txt` | Exact-pinned Python runtime and test dependencies for this demo. |
| `backend/app/config.py` | Typed settings, local paths, file/batch limits, worker count, model name, and review threshold. |
| `backend/app/schemas.py` | Pydantic request/response models and status enums shared by API services. |
| `backend/app/scoring.py` | Pure score mapping, weighted total, manual override, and deterministic ranking helpers. |
| `backend/app/documents.py` | File validation, PDF/DOCX normalization, page extraction, source-span construction, and identifier-masked evaluation text. |
| `backend/app/typesafe_adapter.py` | Jev weight suggestions, per-criterion Score/Choice questions, and typed answer mapping. |
| `backend/app/database.py` | SQLite schema and repository methods for jobs, criteria, candidates, spans, and evaluations. |
| `backend/app/events.py` | Per-job SSE event model, in-process subscriber fan-out, and worker update publisher. |
| `backend/app/worker.py` | Bounded queue, per-CV pipeline, retry, error isolation, and startup recovery. |
| `backend/app/api.py` | HTTP routes for weights, jobs, uploads, snapshots, SSE, previews, review edits, and retry. |
| `backend/app/main.py` | FastAPI app, lifespan-managed resources, local CORS, and router composition. |
| `backend/__init__.py` | Makes the backend importable as `backend.app` from repository-root tests and Uvicorn. |
| `backend/tests/` | Unit and API tests using synthetic files and a fake Jev adapter; no live API key in automated tests. |
| `frontend/vite.config.ts` | React plugin, `/api` development proxy, and Vitest jsdom configuration. |
| `frontend/src/test/setup.ts` | Vitest setup for Testing Library matchers. |
| `frontend/src/types.ts` | TypeScript mirrors of the backend wire contracts. |
| `frontend/src/api.ts` | REST calls and typed EventSource event handling. |
| `frontend/src/App.tsx` | Page-level flow from role setup to upload and results. |
| `frontend/src/components/RoleCriteriaForm.tsx` | Guided criteria entry, Jev weight suggestions, and recruiter confirmation. |
| `frontend/src/components/CvUploadPanel.tsx` | PDF/DOCX batch selection, client-side limits, and upload status. |
| `frontend/src/components/Scorecard.tsx` | Candidate rows, criterion columns, live sort, provisional/final rank labels, and processing states. |
| `frontend/src/components/EvidencePanel.tsx` | Verbatim excerpt, page number, normalized PDF preview, and manual review controls. |
| `frontend/src/**/*.test.tsx` | Component tests for weight confirmation, upload validation, live updates, ranking, and review behavior. |

The project currently contains no app code, package manifests, tests, or existing framework conventions. The installed Python launcher has Python 3.13.5; the default `python` is 3.10.11 and should not be used for this new project. LibreOffice is currently absent.

## Task 1: Bootstrap the local backend and dashboard

**Files:** Create `.gitignore`, `.env.example`, `README.md`, `backend/requirements.txt`, `backend/__init__.py`, `backend/app/__init__.py`, `backend/app/config.py`, `backend/app/main.py`, `backend/tests/test_health.py`, `frontend/vite.config.ts`, `frontend/src/App.test.tsx`, `frontend/src/test/setup.ts`, and the `frontend/` Vite project.

**Interfaces:** `GET /api/health` returns `{"status":"ok"}`. Vite proxies `/api` to `http://127.0.0.1:8000`; the backend serves only on localhost in the demo.

- [ ] **Step 1: Create the local environments and exact-pin dependencies.** Add a `.gitignore` before creating runtime files. Create a Python 3.13 virtual environment with `py -3.13 -m venv backend/.venv`. In `backend/requirements.txt`, pin stable Python 3.13-compatible releases of `fastapi`, `uvicorn[standard]`, `python-multipart`, `pydantic-settings`, `python-dotenv`, `aiosqlite`, `typesafe-sdk`, `pymupdf`, and `python-docx`; include `pytest`, `pytest-asyncio`, and `httpx` for tests. Verify each selected release is at least seven days old, install with `backend/.venv/Scripts/python -m pip install -r backend/requirements.txt`, then run `backend/.venv/Scripts/python -m pip check`.

- [ ] **Step 2: Write the failing backend health test.**

```python
from fastapi.testclient import TestClient

from backend.app.main import app


def test_health_returns_ok():
    response = TestClient(app).get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 3: Run the test and confirm it fails because the app module or route is absent.**

Run: `backend/.venv/Scripts/python -m pytest backend/tests/test_health.py -q`  
Expected: FAIL because `backend.app.main` or `/api/health` does not exist.

- [ ] **Step 4: Create the minimal FastAPI app and health route.**

```python
from fastapi import FastAPI

app = FastAPI(title="SmartCV")


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
```

- [ ] **Step 5: Scaffold the React/TypeScript app and lock compatible releases.** Run `npm create vite@9.2.1 frontend -- --template react-ts`. In `frontend/`, pin React/React DOM `19.3.0`; Vite `8.3.0`, `@vitejs/plugin-react` `6.1.1`, TypeScript `7.0.2`, `@types/react`/`@types/react-dom` `19.3.0`, Vitest `4.1.0`, Testing Library React `16.3.3`, `@testing-library/dom` `10.4.2`, user-event `14.6.1`, jest-dom `7.0.1`, and jsdom `27.0.0` using `npm install --save-exact` and `npm install --save-dev --save-exact`. These releases were checked against npm timestamps and Vite's Node engine; Vite 8.3.0 supports the installed Node 24.14.0. Commit the generated `package-lock.json`.

- [ ] **Step 6: Add a failing frontend smoke test and test configuration.** Configure `frontend/vite.config.ts` with the React plugin, `/api` proxy, jsdom environment, and `./src/test/setup.ts`. Add `"test": "vitest"` to `frontend/package.json`; in `setup.ts`, import `@testing-library/jest-dom/vitest`. Add `App.test.tsx`:

```typescript
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import App from "./App";

it("renders the SmartCV heading", () => {
  render(<App />);
  expect(screen.getByRole("heading", { level: 1, name: "SmartCV" })).toBeInTheDocument();
});
```

Run `npm --prefix frontend run test -- --run` and confirm the test fails because the scaffold page does not render that heading.

- [ ] **Step 7: Implement the minimal frontend page.** Change `frontend/src/App.tsx` to render a `main` containing the `SmartCV` heading. Re-run `npm --prefix frontend run test -- --run`; expected: the smoke test passes.

- [ ] **Step 8: Add local configuration and run scripts.** Put no secret values in `.env.example`: leave `TYPESAFE_API_KEY=` blank and include only non-secret defaults such as `SMARTCV_FAKE_EVALUATOR=false`. Configure `backend/app/config.py` to read `backend/.env`, store the API key as `SecretStr`, use `TYPESAFE_MODEL=jev`, `MAX_BATCH_FILES=200`, `MAX_FILE_BYTES=10000000`, and `WORKER_COUNT=4`, and expose a review-threshold setting calibrated in Task 9. Bind Uvicorn to localhost and never log the settings object. Ensure `.gitignore` excludes `backend/.venv/`, `backend/.env`, `backend/data/`, `*.sqlite3`, `frontend/node_modules/`, and `frontend/dist/`. Document setup/test/run commands in `README.md`, including that the backend requires `TYPESAFE_API_KEY` in live mode and `SMARTCV_FAKE_EVALUATOR=true` is only for an explicit synthetic demo.

- [ ] **Step 9: Run the smoke checks.** Run `backend/.venv/Scripts/python -m pytest backend/tests/test_health.py -q`, `npm --prefix frontend run test -- --run`, and `npm --prefix frontend run build`. Expected: backend and frontend smoke tests pass and the production build succeeds.

- [ ] **Step 10: Commit the scaffold.**

```bash
git add .gitignore .env.example README.md backend/requirements.txt backend/__init__.py backend/app backend/tests/test_health.py frontend
git commit -m "Bootstrap SmartCV demo application"
```

## Task 2: Define the domain contracts and deterministic score calculation

**Files:** Create `backend/app/schemas.py`, `backend/app/scoring.py`, and `backend/tests/test_scoring.py`.

**Interfaces:** `effective_fraction(evaluation) -> float`; `effective_fractions(evaluations) -> dict[str, float]`; `calculate_total_score(weights, fractions) -> float | None`; `rank_candidates(candidates) -> list[CandidateResult]`. A manually reviewed fraction overrides the model fraction; ties retain upload order.

- [ ] **Step 1: Write failing score tests.** Cover strong/partial/not-found fractions, 1–5 weight validation, normalization to 0–100, incomplete evaluations, manual override, and stable tie order.

```python
from types import SimpleNamespace

from backend.app.scoring import calculate_total_score, effective_fraction


def test_weighted_total_uses_confirmed_weights():
    weights = {"python": 3, "api_design": 1}
    fractions = {"python": 0.5, "api_design": 1.0}
    assert calculate_total_score(weights, fractions) == 62.5


def test_incomplete_evaluations_have_no_rankable_score():
    assert calculate_total_score({"python": 3}, {}) is None


def test_manual_fraction_overrides_model_fraction():
    evaluation = SimpleNamespace(model_fraction=0.25, manual_fraction=0.5)
    assert effective_fraction(evaluation) == 0.5
```

- [ ] **Step 2: Run `backend/.venv/Scripts/python -m pytest backend/tests/test_scoring.py -q` and confirm the import fails.**

- [ ] **Step 3: Add Pydantic contracts.** Define `CriterionInput(id: str, name: str, description: str)` for suggestions and `Criterion(id: str, name: str, description: str, weight: int)` for confirmed jobs; `WeightSuggestion(criterion_id: str, proposed_weight: int, confidence: float)`; `EvidenceSpan(id: str, page_number: int, text: str)` for original source text; `EvaluationSpan(id: str, page_number: int, text: str)` for the identifier-masked model view; `CriterionEvaluation(criterion_id: str, status: MatchStatus, confidence: float, model_fraction: float, evidence_span_id: str | None = None, manual_fraction: float | None = None, review_note: str | None = None)`; `CandidateResult(id: str, filename: str, upload_order: int, status: CandidateStatus, evaluations: list[CriterionEvaluation], total_score: float | None, error_message: str | None, retryable: bool)`; and `JobSnapshot(id: str, title: str, criteria: list[Criterion], candidates: list[CandidateResult], completed_count: int, total_count: int, is_final: bool)`. Use enums for `strong`, `partial`, `not_found`, `needs_review`, `reviewed` and candidate states `queued`, `extracting`, `evaluating`, `complete`, `needs_review`, `failed`. Validate weights in the inclusive range 1–5 and fractions/confidence in 0–1.

- [ ] **Step 4: Implement effective fractions, total score, and ranking.** Resolve each evaluation to `manual_fraction` when present and otherwise `model_fraction`. Return `None` until a candidate has an evaluation for every criterion. Compute `round(100 * sum(weight[id] * fraction[id]) / sum(weights), 2)`. Reject non-positive weights. Sort scoreable candidates by descending score, then ascending `upload_order`; keep unscoreable and in-progress candidates outside the ranked subset.

```python
from backend.app.schemas import CandidateResult, CandidateStatus, CriterionEvaluation


def effective_fraction(evaluation):
    if evaluation.manual_fraction is not None:
        return evaluation.manual_fraction
    return evaluation.model_fraction


def effective_fractions(evaluations):
    return {
        criterion_id: effective_fraction(evaluation)
        for criterion_id, evaluation in evaluations.items()
    }


def calculate_total_score(weights, fractions):
    if not fractions or set(fractions) != set(weights):
        return None
    if any(weight <= 0 for weight in weights.values()):
        raise ValueError("At least one positive criterion weight is required")
    total_weight = sum(weights.values())
    weighted_fraction = sum(
        weights[criterion_id] * fractions[criterion_id]
        for criterion_id in weights
    )
    return round(100 * weighted_fraction / total_weight, 2)


def rank_candidates(candidates):
    rankable = [
        candidate
        for candidate in candidates
        if candidate.total_score is not None
        and candidate.status in {CandidateStatus.COMPLETE, CandidateStatus.NEEDS_REVIEW}
    ]

    def ranking_key(candidate):
        assert candidate.total_score is not None
        return (-candidate.total_score, candidate.upload_order)

    return sorted(rankable, key=ranking_key)
```

- [ ] **Step 5: Run the scoring tests and boundary tests.** Run `backend/.venv/Scripts/python -m pytest backend/tests/test_scoring.py -q`. Expected: formula, manual override, invalid weight/fraction, incomplete result, and stable tie tests pass.

- [ ] **Step 6: Commit the domain and score helper.**

```bash
git add backend/app/schemas.py backend/app/scoring.py backend/tests/test_scoring.py
git commit -m "Add transparent candidate scoring model"
```

## Task 3: Parse PDF and DOCX files into page-linked evidence spans

**Files:** Create `backend/app/documents.py` and `backend/tests/test_documents.py`; generate synthetic PDF/DOCX fixtures during test setup rather than committing binary CV files.

**Interfaces:** `parse_cv(path: Path, original_filename: str) -> ParsedDocument`; `ParsedDocument` contains a normalized preview path and ordered `EvidenceSpan` values. Raise typed `UnsupportedFile`, `UnreadableDocument`, `NeedsManualReview`, or `RendererUnavailable` errors; the worker converts these to per-file statuses and retryability.

- [ ] **Step 1: Install the external DOCX renderer before testing conversion.** `soffice --version` currently fails in this workspace. Install LibreOffice on the development machine using its official installer, then verify `soffice --version`. Do not use `shell=True` or build a command string from an uploaded filename.

- [ ] **Step 2: Write failing parser tests.** Generate a text PDF with PyMuPDF and a DOCX with python-docx. Assert extracted page numbers are one-based, extracted evidence text is verbatim, email/phone/contact lines are removed from the evaluation view but preserved in the source spans, unknown extensions are rejected, invalid file signatures are rejected, and image-only/no-text PDFs return manual-review status rather than an empty successful parse.

- [ ] **Step 3: Run the parser tests before implementation.** Run `backend/.venv/Scripts/python -m pytest backend/tests/test_documents.py -q`. Expected: FAIL because `backend.app.documents` does not exist yet.

- [ ] **Step 4: Implement upload validation.** Allow only `.pdf` and `.docx`, verify PDF magic bytes or DOCX ZIP structure, stream the upload to a server-generated UUID path, and enforce `MAX_BATCH_FILES = 200` and `MAX_FILE_BYTES = 10_000_000`. Never use a user-provided path as a destination.

- [ ] **Step 5: Implement PDF extraction.** Use PyMuPDF to read each page in order, preserve one-based page numbers, split non-empty text blocks into deterministic evidence spans, and assign IDs stable within the candidate. If no usable text is found, raise `NeedsManualReview("No selectable text; OCR is not supported in the MVP")`.

```python
from dataclasses import dataclass
from pathlib import Path
import re

import pymupdf

from backend.app.schemas import EvaluationSpan, EvidenceSpan


@dataclass(frozen=True)
class ParsedDocument:
    preview_path: Path
    spans: list[EvidenceSpan]


def extract_pdf_spans(path: Path) -> list[EvidenceSpan]:
    spans = []
    with pymupdf.open(path) as document:
        for page_number, page in enumerate(document, start=1):
            for block_number, block in enumerate(page.get_text("blocks", sort=True)):
                text = block[4].strip()
                if text:
                    spans.append(EvidenceSpan(
                        id=f"p{page_number}-b{block_number}",
                        page_number=page_number,
                        text=text,
                    ))
    if not spans:
        raise NeedsManualReview("No selectable text; OCR is not supported in the MVP")
    return spans


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
            evaluation_spans.append(EvaluationSpan(
                id=span.id,
                page_number=span.page_number,
                text=text.strip(),
            ))
    return evaluation_spans
```

- [ ] **Step 6: Implement DOCX normalization.** Resolve LibreOffice with `shutil.which("soffice")` and raise `RendererUnavailable` when it returns `None`. Create a unique `profile_dir` under the candidate's `TemporaryDirectory` and call `profile_dir.mkdir()`; pass `profile_dir.as_uri()` to avoid LibreOffice profile-lock conflicts in the four-worker pool. Convert with `subprocess.run([soffice, f"-env:UserInstallation={profile_dir.as_uri()}", "--headless", "--convert-to", "pdf", "--outdir", str(temp_dir), str(source_path)], check=True, timeout=30, capture_output=True)`. Validate the expected output file, move it to the candidate's generated storage directory, then use the same PDF extraction path. Return preview page numbers from this normalized PDF so the excerpt and preview agree.

- [ ] **Step 7: Re-run parser tests and add failure tests.** Cover corrupt ZIP, conversion timeout, missing renderer, empty pages, and a file over 10 MB. Run `backend/.venv/Scripts/python -m pytest backend/tests/test_documents.py -q`. Expected: each failure is typed and contains a recruiter-safe message without logging source text.

- [ ] **Step 8: Commit the parser.**

```bash
git add backend/app/documents.py backend/tests/test_documents.py
git commit -m "Extract page-linked CV evidence safely"
```

## Task 4: Add the Jev adapter for weight suggestions and criterion judgments

**Files:** Create `backend/app/typesafe_adapter.py` and `backend/tests/test_typesafe_adapter.py`.

**Interfaces:** `suggest_weights(criteria) -> list[WeightSuggestion]`; `evaluate_candidate(criteria, spans) -> list[CriterionEvaluation]`. Inject the SDK client and review threshold so tests do not call the live service.

- [ ] **Step 1: Write failing adapter tests with a fake SDK response.** Cover weight mapping into 1–5, Score normalization, Choice evidence selection, the `no_match` option, low-confidence review flags, and inconsistent Score/Choice answers.

- [ ] **Step 2: Run the adapter tests before implementation.** Run `backend/.venv/Scripts/python -m pytest backend/tests/test_typesafe_adapter.py -q`. Expected: FAIL because the evaluator adapter and its methods are not implemented.

- [ ] **Step 3: Create the evaluator in FastAPI lifespan.** In live mode, require `TYPESAFE_API_KEY`, create one shared `AsyncTypeSafeClient(api_key=settings.typesafe_api_key.get_secret_value(), model="jev")`, and close it at shutdown. When `SMARTCV_FAKE_EVALUATOR=true`, inject a deterministic fake evaluator and do not create the TypeSafe client; never switch to fake scoring after a live-service error. Configure the `typesafe_sdk` logger at `WARNING` because SDK documentation notes that request/response bodies are not redacted. Do not log raw CV state or API-key values. Wrap exhausted service/transport errors in an app-owned `RetryableEvaluationError` so the worker can retry after a transient outage or credential correction without exposing provider response bodies.

- [ ] **Step 4: Implement weight suggestions.** Send all criterion questions for one job in a single `system_one` request. Use a `Score` with five ordered, concrete importance levels whose indices represent weights 1–5. Convert the zero-based expected level to an integer with `max(1, min(5, int(answer.score + 0.5) + 1))`, retain the model confidence for display, and require recruiter confirmation before creating a screening job.

- [ ] **Step 5: Implement per-candidate judgments.** For each candidate, send one `system_one` request containing independent questions for each criterion: a three-level `Score` (no relevant evidence, partial evidence, strong evidence) and a `Choice` over source-span IDs plus an explicit `no_match` option. Build the request's named criteria and page-linked spans with `prepare_evaluation_spans(source_spans)`; IDs and page numbers stay unchanged while contact identifiers are masked. Do not include candidate display names as separate state. Map the most-probable Score level to `not_found`/0.0, `partial`/0.5, or `strong`/1.0; retain its probability distribution and use the lower of the Score and Choice confidences as the evaluation confidence. Resolve the displayed excerpt from the selected ID in the original, unmodified spans, never from generated text.

```python
from backend.app.documents import prepare_evaluation_spans
from backend.app.schemas import CriterionEvaluation, EvidenceSpan
from typesafe_sdk import Choice, Score

source_spans = [
    EvidenceSpan(id="p1-b0", page_number=1, text="Built Python APIs for three years.")
]
spans = prepare_evaluation_spans(source_spans)
match_levels = [
    "No relevant evidence in the CV supports this criterion.",
    "Partial or indirect evidence supports some parts of the criterion.",
    "Clear direct or equivalent evidence supports the criterion.",
]
span = spans[0]
questions = {
    "score_python": Score(
        instructions="How strongly does the CV evidence meet the Python requirement? Assess only job-related evidence and ignore personal identity or demographic characteristics.",
        criteria=match_levels,
    ),
    "evidence_python": Choice(
        instructions="Which span best supports the Python requirement? Choose no_match if none does.",
        criteria={
            span.id: f"Page {span.page_number}: {span.text}",
            "no_match": "No listed span supports the requirement.",
        },
    ),
}
result = await client.system_one(
    state={
        "criterion": {"id": "python", "description": "Build Python backend services."},
        "spans": [span.model_dump(mode="json") for span in spans],
    },
    questions=questions,
)
score_answer = result.scores["score_python"]
evidence_answer = result.choices["evidence_python"]
level_index = int(max(score_answer.probabilities, key=lambda level: score_answer.probabilities[level]))
fraction = [0.0, 0.5, 1.0][level_index]
match_status = ["not_found", "partial", "strong"][level_index]
source_by_id = {source_span.id: source_span for source_span in source_spans}
quoted_span = source_by_id.get(evidence_answer.choice)
confidence = min(score_answer.confidence, evidence_answer.confidence)
if (
    confidence <= review_threshold
    or (evidence_answer.choice == "no_match" and match_status != "not_found")
    or (evidence_answer.choice != "no_match" and match_status == "not_found")
    or (evidence_answer.choice != "no_match" and quoted_span is None)
):
    match_status = "needs_review"
evaluation = CriterionEvaluation(
    criterion_id="python",
    status=match_status,
    confidence=confidence,
    model_fraction=fraction,
    evidence_span_id=None if evidence_answer.choice == "no_match" else evidence_answer.choice,
)
```

- [ ] **Step 6: Route uncertainty and contradictions to review.** Mark the evaluation `needs_review` if either answer's confidence is at or below the injected demo threshold, the selected span ID does not exist, `no_match` conflicts with a Score whose most-probable level is partial/strong, or a selected span conflicts with a most-probable `not_found` level. Otherwise map the most-probable Score level to `not_found`, `partial`, or `strong`. Keep the normalized Score fraction and best evidence estimate visible; never convert low confidence into an automatic rejection.

- [ ] **Step 7: Re-run adapter tests.** Run `backend/.venv/Scripts/python -m pytest backend/tests/test_typesafe_adapter.py -q` with fake SDK answers only. Add an opt-in live smoke command that requires `TYPESAFE_API_KEY` and uses synthetic text only; no API key is committed or exposed to the frontend.

- [ ] **Step 8: Commit the Jev adapter.**

```bash
git add backend/app/typesafe_adapter.py backend/tests/test_typesafe_adapter.py
git commit -m "Add structured Jev screening judgments"
```

## Task 5: Persist jobs and run each CV through a bounded worker pool

**Files:** Create `backend/app/database.py`, `backend/app/worker.py`, and `backend/tests/test_worker.py`.

**Interfaces:** `SQLiteRepository.create_job`, `add_candidates`, `get_candidate(candidate_id) -> CandidateWorkItem`, `get_job_snapshot`, `save_source_spans(candidate_id, preview_path, spans)`, `save_candidate_result`, `set_candidate_status(candidate_id, status)`, `mark_candidate_needs_review(candidate_id, error_message)`, `mark_candidate_failed(candidate_id, error_message, retryable)`, `update_manual_evaluation`, `list_resumable_candidates`, and `mark_job_complete_if_terminal(job_id) -> bool`; `EventPublisher.publish_candidate_update(job_id, candidate_id)`; `CandidateWorkerPool.start`, `enqueue`, and `stop`; `build_candidate_result(candidate, evaluations) -> CandidateResult`. `CandidateWorkItem` carries `id`, `job_id`, `filename`, `stored_path`, `upload_order`, and confirmed role criteria.

- [ ] **Step 1: Write repository and worker tests against a temporary SQLite database.** Assert jobs and confirmed weights persist, each candidate can be updated independently, and a failed candidate does not change other candidate statuses.

- [ ] **Step 2: Run the repository/worker tests before implementation.** Run `backend/.venv/Scripts/python -m pytest backend/tests/test_worker.py -q`. Expected: FAIL because the repository and worker pool are not implemented.

- [ ] **Step 3: Create SQLite tables with `aiosqlite`.** Store jobs, ordered criteria with recruiter-confirmed weights, candidates with UUID and upload order, source spans with page references, original model evaluations, manual overrides/review notes, and safe error codes. Open the async connection during FastAPI lifespan; use an `asyncio.Lock` around multi-statement write transactions and never hold it during parsing or Jev calls. Store files only under `backend/data/`; store no raw CV text in logs.

- [ ] **Step 4: Implement a bounded `asyncio.Queue` worker pool.** Use four workers by default, configurable through settings. Each worker performs `queued → extracting → evaluating → complete|needs_review`. Publish status events after each transition so the dashboard can show active processing. Map `NeedsManualReview` (for example, an image-only PDF) to `needs_review` with no score. Map invalid signatures and deterministic corrupt-file errors to non-retryable `failed`; map missing LibreOffice and transient TypeSafe service errors to retryable `failed`. Save every status/result before publishing its event; never assign zero points to a file that produced no evaluations.

```python
import asyncio

from backend.app.documents import (
    NeedsManualReview,
    RendererUnavailable,
    UnreadableDocument,
    UnsupportedFile,
    parse_cv,
)
from backend.app.schemas import CandidateStatus
from backend.app.typesafe_adapter import RetryableEvaluationError


async def process_candidate(self, candidate_id: str) -> None:
    candidate = await self.repository.get_candidate(candidate_id)
    await self.repository.set_candidate_status(candidate_id, CandidateStatus.EXTRACTING)
    await self.event_publisher.publish_candidate_update(candidate.job_id, candidate_id)
    try:
        parsed = await asyncio.to_thread(
            parse_cv, candidate.stored_path, candidate.filename
        )
    except NeedsManualReview as error:
        await self.repository.mark_candidate_needs_review(candidate_id, str(error))
        await self.event_publisher.publish_candidate_update(candidate.job_id, candidate_id)
        return
    except RendererUnavailable as error:
        await self.repository.mark_candidate_failed(candidate_id, str(error), retryable=True)
        await self.event_publisher.publish_candidate_update(candidate.job_id, candidate_id)
        return
    except (UnsupportedFile, UnreadableDocument) as error:
        await self.repository.mark_candidate_failed(candidate_id, str(error), retryable=False)
        await self.event_publisher.publish_candidate_update(candidate.job_id, candidate_id)
        return
    await self.repository.save_source_spans(candidate_id, parsed.preview_path, parsed.spans)
    await self.repository.set_candidate_status(candidate_id, CandidateStatus.EVALUATING)
    await self.event_publisher.publish_candidate_update(candidate.job_id, candidate_id)
    try:
        evaluations = await self.evaluator.evaluate_candidate(candidate.criteria, parsed.spans)
    except RetryableEvaluationError as error:
        await self.repository.mark_candidate_failed(candidate_id, str(error), retryable=True)
        await self.event_publisher.publish_candidate_update(candidate.job_id, candidate_id)
        return
    result = build_candidate_result(candidate, evaluations)
    await self.repository.save_candidate_result(result)
    await self.event_publisher.publish_candidate_update(candidate.job_id, candidate_id)
```

- [ ] **Step 5: Add restart recovery.** At startup, re-enqueue candidates persisted as `queued` or stale `extracting/evaluating`; use idempotent result writes so a retry does not duplicate a candidate. On shutdown, stop accepting new work and drain active jobs within a bounded timeout.

- [ ] **Step 6: Add manual review updates.** Preserve the original Jev fraction and confidence separately from `manual_fraction`. A recruiter override sets the cell status to `reviewed` and takes precedence only in the deterministic total; retain the original result and review note for audit. After recalculation, keep the candidate status `needs_review` while any cell still needs review; otherwise set it to `complete`.

- [ ] **Step 7: Test concurrency and failure isolation.** Use a fake parser/evaluator with controllable delays and errors. Assert no more than four candidates are active simultaneously, successful candidates finish while one fails, and recovered candidates can be re-enqueued.

- [ ] **Step 8: Run `backend/.venv/Scripts/python -m pytest backend/tests/test_worker.py -q` and commit.**

```bash
git add backend/app/database.py backend/app/worker.py backend/tests/test_worker.py
git commit -m "Persist and process CV batches independently"
```

## Task 6: Expose the API and SSE event stream

**Files:** Create `backend/app/events.py`, `backend/app/api.py`; modify `backend/app/main.py`; create `backend/tests/test_api.py` and `backend/tests/test_events.py`.

**Interfaces:**

- `POST /api/weight-suggestions` accepts `WeightSuggestionRequest` and returns proposed weights plus confidence.
- `POST /api/jobs` accepts `JobCreate` with recruiter-confirmed weights and creates a job.
- `POST /api/jobs/{job_id}/cvs` accepts multipart files, up to 200, and returns one candidate status per file; valid files queue, while an invalid individual file becomes a visible failed row without blocking valid files.
- `GET /api/jobs/{job_id}` returns the current `JobSnapshot`.
- `GET /api/jobs/{job_id}/events` returns `snapshot`, `candidate.updated`, `job.progress`, and `job.complete` SSE events.
- `GET /api/jobs/{job_id}/candidates/{candidate_id}/preview` serves the normalized PDF preview.
- `PATCH /api/jobs/{job_id}/candidates/{candidate_id}/criteria/{criterion_id}` accepts a `ReviewUpdate`.
- `POST /api/jobs/{job_id}/candidates/{candidate_id}/retry` retries one retryable failed CV.

Wire schemas are `WeightSuggestionRequest(criteria: list[CriterionInput])`, `JobCreate(title: str, criteria: list[Criterion])`, `BatchUploadResponse(candidates: list[CandidateResult], total_count: int)`, and `ReviewUpdate(match_level: Literal["not_found", "partial", "strong"], review_note: str | None)`. `JobEvent` contains `name` and `payload`; `candidate.updated` payloads contain `candidate`, `completed_count`, and `total_count`; `job.progress` payloads contain the two counts; `snapshot` and `job.complete` payloads are `JobSnapshot` values.

- [ ] **Step 1: Write failing event-hub tests.** Cover broadcast to multiple subscribers, per-job isolation, event serialization, subscriber cleanup, and atomic job-completion publication.

- [ ] **Step 2: Run the event-hub tests before implementation.** Run `backend/.venv/Scripts/python -m pytest backend/tests/test_events.py -q`. Expected: FAIL because `EventHub` and `EventPublisher` do not exist.

- [ ] **Step 3: Implement the event hub and publisher adapter.** `EventHub.subscribe(job_id)` is an async context manager yielding an `AsyncIterator[JobEvent]`; `EventHub.publish(job_id, event)` broadcasts to every subscriber and unregisters closed subscribers. `EventPublisher.publish_candidate_update(job_id, candidate_id)` emits the fresh candidate and progress counts, calls `mark_job_complete_if_terminal(job_id)`, and emits `job.complete` only when that atomic repository method returns true. The hub is process-local; the initial SSE snapshot is the reconnect/recovery mechanism.

- [ ] **Step 4: Write failing API tests.** Cover valid job creation, invalid weight rejection, wrong job ID, a 201 mixed-batch response where one corrupt/unsupported file is non-retryable `failed` and valid files are queued, acceptance of exactly 200 files, a 413 response for 201 files with no partial write, snapshot contents, manual override recalculation, successful retry of a transient failure, and rejection of retry for a non-retryable file error.

- [ ] **Step 5: Run API tests before implementing routes.** Run `backend/.venv/Scripts/python -m pytest backend/tests/test_api.py -q`. Expected: FAIL because the routes are not registered.

- [ ] **Step 6: Implement routes with typed request/response schemas.** Return 404 for unknown IDs, 413 when the batch has more than 200 files, 422 for invalid criteria/weights, and 409 when retry is requested for a non-retryable failure. Validate each file independently; return a failed candidate status for unsupported extensions, bad signatures, oversize files, or corrupt content while continuing to queue valid files in the same batch. For review updates, map `not_found → 0`, `partial → 0.5`, and `strong → 1.0`, store the manual fraction/note separately from Jev's result, recalculate the total, and return the updated candidate. Never expose filesystem paths, CV text in server errors, API keys, or provider request bodies.

- [ ] **Step 7: Implement SSE without a snapshot/update race.** Subscribe to the event hub first, then read and emit the current snapshot, then emit queued live events. Use `text/event-stream`, `Cache-Control: no-cache`, and JSON event payloads. Upserts by candidate UUID make a repeated snapshot/update idempotent. Define `encode_sse(name: str, payload: dict[str, object]) -> str` to JSON-encode one event and terminate it with a blank line.

```python
import json


async def stream_job(job_id: str):
    async with event_hub.subscribe(job_id) as subscriber:
        snapshot = await repository.get_job_snapshot(job_id)
        yield encode_sse("snapshot", snapshot.model_dump(mode="json"))
        async for event in subscriber:
            yield encode_sse(event.name, event.payload)


def encode_sse(name: str, payload: dict[str, object]) -> str:
    data = json.dumps(payload, separators=(",", ":"))
    return f"event: {name}\ndata: {data}\n\n"
```

- [ ] **Step 8: Add API integration tests using a fake evaluator.** Open the stream, upload synthetic CVs, assert processing and candidate-result updates arrive before the full batch finishes, and assert one terminal `job.complete` event after every candidate is `complete`, `needs_review`, or `failed`. Run `backend/.venv/Scripts/python -m pytest backend/tests/test_api.py backend/tests/test_events.py -q`.

```bash
git add backend/app/events.py backend/app/api.py backend/app/main.py backend/tests/test_api.py backend/tests/test_events.py
git commit -m "Stream per-CV screening results over SSE"
```

## Task 7: Build role setup, confirmed weights, and batch upload UI

**Files:** Create `frontend/src/types.ts`, `frontend/src/api.ts`, `frontend/src/components/RoleCriteriaForm.tsx`, `frontend/src/components/RoleCriteriaForm.test.tsx`, `frontend/src/components/CvUploadPanel.tsx`, and `frontend/src/components/CvUploadPanel.test.tsx`; modify `frontend/src/App.tsx` and `frontend/vite.config.ts`.

**Interfaces:** `suggestWeights(criteria)`, `createJob(job)`, `uploadCvs(jobId, files)`, and `getJobSnapshot(jobId)` in `api.ts`. `BatchUploadResponse` is `{ candidates: CandidateResult[]; total_count: number }`. Frontend wire types mirror the Pydantic schemas using the API's snake_case field names.

- [ ] **Step 1: Write failing form tests.** Verify a role needs at least one criterion, suggestion values are editable, uploading is disabled until weights are confirmed, and invalid weights outside 1–5 show an accessible error.

- [ ] **Step 2: Run the form tests before implementation.** Run `npm --prefix frontend run test -- --run`; expected: the new form tests fail because `RoleCriteriaForm` is not implemented.

- [ ] **Step 3: Implement `RoleCriteriaForm`.** Support role title and repeatable criterion name/description rows. Request suggested weights, display confidence as a review cue, allow recruiter edits, and submit only confirmed weights to `POST /api/jobs`. If Jev weight suggestions fail, allow the recruiter to set all weights manually and continue; never use unconfirmed suggestions.

- [ ] **Step 4: Write failing upload tests.** Verify PDF/DOCX acceptance, local rejection/status for unsupported extensions, continuation with valid files when a selection is mixed, and that an empty valid subset or more than 200 files does not call the backend.

- [ ] **Step 5: Run the upload tests before implementation.** Run `npm --prefix frontend run test -- --run`; expected: the new upload tests fail because `CvUploadPanel` is not implemented.

- [ ] **Step 6: Implement `CvUploadPanel`.** Use `FormData` for supported PDF/DOCX files, preserve individual filenames for display only, upload the valid subset to the job batch route, and show client-side rejects and server per-file failures without clearing the confirmed role. Do not send the TypeSafe key from the browser.

```typescript
import type { BatchUploadResponse } from "./types";

export async function uploadCvs(jobId: string, files: File[]): Promise<BatchUploadResponse> {
  const form = new FormData();
  for (const file of files) form.append("files", file);
  const response = await fetch(`/api/jobs/${jobId}/cvs`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw new Error(`Upload failed (${response.status})`);
  return (await response.json()) as BatchUploadResponse;
}
```

- [ ] **Step 7: Configure Vite proxy and run component tests/build.** Use `npm --prefix frontend run test -- --run` and `npm --prefix frontend run build`.

```bash
git add frontend/src/types.ts frontend/src/api.ts frontend/src/App.tsx frontend/src/components/RoleCriteriaForm.tsx frontend/src/components/RoleCriteriaForm.test.tsx frontend/src/components/CvUploadPanel.tsx frontend/src/components/CvUploadPanel.test.tsx frontend/vite.config.ts
git commit -m "Add role criteria and CV upload flow"
```

## Task 8: Render live scorecards, evidence, and recruiter corrections

**Files:** Create `frontend/src/components/Scorecard.tsx`, `frontend/src/components/Scorecard.test.tsx`, `frontend/src/components/EvidencePanel.tsx`, and `frontend/src/components/EvidencePanel.test.tsx`; modify `frontend/src/api.ts`, `frontend/src/App.tsx`, and `frontend/src/types.ts`.

**Interfaces:** `JobEvent` is a discriminated union for `snapshot`, `candidate.updated`, `job.progress`, and `job.complete` using the payload contracts from Task 6. `connectToJobEvents(jobId, onEvent, onError) -> () => void` returns an unsubscribe function; `onEvent` receives `JobEvent` and `onError` receives malformed-stream/network errors. `Scorecard` receives `JobSnapshot` and emits review/retry actions; `EvidencePanel` receives a candidate, criterion evaluation, and preview URL.

- [ ] **Step 1: Write failing live-update tests.** Feed a snapshot, then two `candidate.updated` events with scores in reverse completion order. Assert rows are upserted once, sorted by descending total, and ranks are labeled provisional while any candidate is processing.

- [ ] **Step 2: Run the live-update tests before implementation.** Run `npm --prefix frontend run test -- --run`; expected: the tests fail because scorecard event handling is not implemented.

- [ ] **Step 3: Implement typed SSE handling.** Register listeners for `snapshot`, `candidate.updated`, `job.progress`, and `job.complete`; parse JSON with a guarded decoder, update state by candidate UUID, and close `EventSource` on job change or component unmount.

```typescript
import type { JobEvent } from "./types";

export function connectToJobEvents(
  jobId: string,
  onEvent: (event: JobEvent) => void,
  onError: (error: Error) => void,
): () => void {
  const source = new EventSource(`/api/jobs/${jobId}/events`);
  const names: JobEvent["name"][] = ["snapshot", "candidate.updated", "job.progress", "job.complete"];
  const listener = (event: Event) => {
    const message = event as MessageEvent<string>;
    try {
      onEvent({ name: event.type as JobEvent["name"], payload: JSON.parse(message.data) } as JobEvent);
    } catch {
      onError(new Error("Invalid live update"));
    }
  };
  for (const name of names) source.addEventListener(name, listener);
  source.onerror = () => onError(new Error("Live update connection failed"));
  return () => source.close();
}
```

- [ ] **Step 4: Implement the scorecard.** Render one row per CV and one column per criterion with status, points, total, and review badge. Initialize from `snapshot.payload.candidates`; for `candidate.updated`, upsert `[payload.candidate]` and re-sort. Rank `complete` or `needs_review` candidates only when `total_score` is not null. Keep processing, failed, and no-score manual-attention rows outside the ranked subset, and switch to final labels only after `job.complete`.

```typescript
import type { CandidateResult } from "../types";

function upsertAndSort(current: CandidateResult[], incoming: CandidateResult[]) {
  const byId = new Map(current.map((candidate) => [candidate.id, candidate]));
  for (const candidate of incoming) byId.set(candidate.id, candidate);
  return [...byId.values()].sort((left, right) => {
    const leftRankable = left.total_score !== null && ["complete", "needs_review"].includes(left.status);
    const rightRankable = right.total_score !== null && ["complete", "needs_review"].includes(right.status);
    if (leftRankable !== rightRankable) return leftRankable ? -1 : 1;
    if (leftRankable && rightRankable) {
      return (right.total_score! - left.total_score!) || left.upload_order - right.upload_order;
    }
    return left.upload_order - right.upload_order;
  });
}
```

- [ ] **Step 5: Implement evidence inspection.** Open exact verified source excerpt and page; show the normalized PDF preview at that page. Provide recruiter controls for `not_found`, `partial`, or `strong` review level and submit the manual override; update displayed total/rank from the response.

```typescript
import type { CandidateResult } from "./types";

export async function reviewCriterion(
  jobId: string,
  candidateId: string,
  criterionId: string,
  matchLevel: "not_found" | "partial" | "strong",
  reviewNote: string,
): Promise<CandidateResult> {
  const response = await fetch(
    `/api/jobs/${jobId}/candidates/${candidateId}/criteria/${criterionId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ match_level: matchLevel, review_note: reviewNote }),
    },
  );
  if (!response.ok) throw new Error(`Review update failed (${response.status})`);
  return (await response.json()) as CandidateResult;
}
```

- [ ] **Step 6: Implement retry UI and accessible states.** Expose retry only when a row is `failed` and `retryable`; otherwise show the safe error message and let the recruiter upload a corrected file. Use semantic table headers, keyboard-accessible evidence controls, visible status text, and a live region for new results without moving focus.

- [ ] **Step 7: Run component tests and production build.** Run `npm --prefix frontend run test -- --run` and `npm --prefix frontend run build`. Verify ranks reorder, uncertain results remain flagged, failed files never get zero points, and manual review changes the total.

```bash
git add frontend/src/api.ts frontend/src/App.tsx frontend/src/types.ts frontend/src/components/Scorecard.tsx frontend/src/components/Scorecard.test.tsx frontend/src/components/EvidencePanel.tsx frontend/src/components/EvidencePanel.test.tsx
git commit -m "Show streamed rankings and source evidence"
```

## Task 9: Create the synthetic validation batch and verify the whole MVP

**Files:** Create `backend/scripts/generate_demo_batch.py`, `backend/tests/test_batch_flow.py`, and any small text fixtures under `backend/tests/fixtures/`; update `README.md` with the final local workflow.

- [ ] **Step 1: Generate a synthetic job and 25 CV files.** Include direct evidence, equivalent wording, partial evidence, missing evidence, ambiguous/conflicting evidence, DOCX, text PDF, no-text PDF, and corrupt-file cases. Do not use real names, real employers, or real applicant data. Write generated files only under ignored `backend/data/demo/`.

```python
import json
from pathlib import Path

import pymupdf
from docx import Document


def write_pdf(path, text):
    document = pymupdf.open()
    page = document.new_page()
    if text:
        page.insert_text((72, 72), text)
    document.save(path)
    document.close()


def write_docx(path, text):
    document = Document()
    document.add_paragraph(text)
    document.save(path)


scenarios = [
    "Built Python REST APIs and PostgreSQL services for three years.",
    "Developed server-side services in Python with relational databases.",
    "Used Python in a university project; no production API experience stated.",
    "Worked in customer support; no programming evidence appears in this CV.",
    "Lists Python and backend development, but gives no dates or project details.",
]
DEMO_JOB = {
    "title": "Backend Engineer",
    "criteria": [
        {"id": "python", "name": "Python", "description": "Build Python backend services.", "weight": 5},
        {"id": "production", "name": "Production experience", "description": "Show professional production-service experience.", "weight": 4},
        {"id": "postgresql", "name": "PostgreSQL", "description": "Use PostgreSQL in backend services.", "weight": 3},
    ],
}
output_dir = Path("backend/data/demo")
output_dir.mkdir(parents=True, exist_ok=True)
(output_dir / "job.json").write_text(json.dumps(DEMO_JOB, indent=2), encoding="utf-8")
for index in range(25):
    path = output_dir / f"synthetic-{index:02}.pdf"
    if index < 20:
        text = scenarios[index % len(scenarios)]
        if index % 2 == 0:
            write_pdf(path, text)
        else:
            write_docx(path.with_suffix(".docx"), text)
    elif index < 23:
        write_pdf(path, "")
    else:
        path.write_bytes(b"not a PDF")
```

Run: `backend/.venv/Scripts/python backend/scripts/generate_demo_batch.py`

- [ ] **Step 2: Run the batch end-to-end with an explicit fake evaluator.** The fake evaluator must be selected by `SMARTCV_FAKE_EVALUATOR=true`; provider failures must not silently switch to fake scoring. Confirm every CV reaches a terminal status and each successful result streams before the last file completes.

- [ ] **Step 3: Run a separate opt-in Jev smoke test on synthetic text.** Set `TYPESAFE_API_KEY` only in the backend environment; confirm the backend receives structured Score/Choice responses and no request body or key appears in logs. Automated tests remain offline.

- [ ] **Step 4: Calibrate the review-highlight threshold on real Jev outputs from the synthetic set.** Review every per-criterion result and label it correct, ambiguous, or incorrect against the source CV. Sweep `confidence <= threshold` from `0.00` to `1.00` in `0.05` increments; for each value record the fraction flagged and the number of ambiguous/incorrect results flagged. Choose the lowest threshold that flags every observed ambiguous/incorrect result while flagging the fewest correct results. If the sample has no labeled errors, use `1.00` for the demo and report that the threshold could not be meaningfully calibrated. The threshold may add a review flag only; it must never remove a candidate or trigger rejection.

- [ ] **Step 5: Verify PDF/DOCX source locations.** Open a page-linked excerpt from each format and confirm the normalized preview displays the exact supporting text on that page. Verify a scanned PDF receives manual attention and never receives a fabricated zero score.

- [ ] **Step 6: Run all automated checks.** Run `backend/.venv/Scripts/python -m pytest backend/tests -q`, `npm --prefix frontend run test -- --run`, `npm --prefix frontend run build`, and `git status --short`. Expected: all tests pass, the frontend builds, and runtime data/credentials are not tracked.

- [ ] **Step 7: Perform the manual browser acceptance pass.** Start the backend with `backend/.venv/Scripts/python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000` and frontend with `npm --prefix frontend run dev -- --host 127.0.0.1`. Create a role, confirm suggested weights, upload the synthetic batch, observe provisional rankings reorder as each CV completes, inspect evidence/page previews, retry one failure, and confirm final ranking after all files reach terminal states.

- [ ] **Step 8: Commit the validation fixtures and setup instructions.**

```bash
git add backend/scripts/generate_demo_batch.py backend/tests/test_batch_flow.py README.md
git commit -m "Validate streamed screening with synthetic CVs"
```

## Execution notes

- The current workspace has no application dependencies or patterns, so these paths are new. The spec is already committed; this plan is a separate, currently uncommitted planning artifact.
- TypeSafe's current Python SDK documents `AsyncTypeSafeClient.system_one(...)` and typed `result.scores[...]` / `result.choices[...]`. Batch independent per-criterion questions into one request per candidate; do not issue a free-form “rank this CV” generation prompt.
- The TypeSafe docs' resume-scoring example supports the architectural fit only. The synthetic validation batch is required before making accuracy or time-saved claims.
- The event hub and worker pool are intentionally process-local for the synthetic-data demo. A durable broker, authentication, retention/deletion policy, production hosting, and real applicant data are outside this plan.
- Run the plan in task order. Each task ends with its targeted tests and a commit using the configured user identity; do not add agent/tool trailers.

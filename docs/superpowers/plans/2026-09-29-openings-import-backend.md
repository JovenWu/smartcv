# Openings Workspace Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the frontend's in-memory stores with a real backend: openings CRUD on the richer domain model, a LangGraph + `openai/gpt-6-luna` (OpenRouter) listing-import agent with Tavily fallback and Jev weight suggestions, and a debounced Jev skill→criteria classifier — all testable end-to-end.

**Architecture:** FastAPI + SQLite (migrated schema) under `/api/openings`, camelCase wire format matching `frontend/src/types.ts`. A `ListingImporter` service (LangGraph `StateGraph`, plain `httpx` for OpenRouter/Tavily) produces unpersisted `ImportDraft`s; `TypeSafeEvaluator` gains `suggest_criteria` for debounced skill classification. Frontend `lib/` stores keep their API surface but fetch/mutate over HTTP and SSE.

**Tech Stack:** Python 3.13, FastAPI, aiosqlite, typesafe-sdk 0.7.1, langgraph 1.2.12 (pinned, released 2026-09-21), httpx (OpenRouter + Tavily), pymupdf/python-docx, pytest/pytest-asyncio, React 19 + Vite + Vitest.

**Spec:** `docs/superpowers/specs/2026-09-29-openings-import-backend-design.md`

## Global Constraints

- Exact-pinned deps, releases ≥7 days old; commit `backend/requirements.txt`.
- Keys server-side only: `OPENROUTER_API_KEY`, `TAVILY_API_KEY`, `TYPESAFE_API_KEY`; never logged, never in repo.
- `SMARTCV_FAKE_EVALUATOR`/`SMARTCV_FAKE_IMPORTER` are explicit opt-ins — never silent fallbacks.
- Jev never sees candidate names/emails/phones; evidence stays verbatim + page-linked.
- No OCR for CVs: candidate uploads accept `.pdf,.docx` only; images only via listing import (multimodal model).
- API responses are camelCase (pydantic `alias_generator=to_camel`, `populate_by_name=True`); Python internals stay snake_case.
- Commit messages: no agent/tool attribution, co-author trailers, or generated-by footers.
- Run backend tests: `backend/.venv/Scripts/python -m pytest backend/tests -q` from repo root.
- Frontend checks: `cd frontend && npm run test -- --run`, `npm run build`, `npm run lint`.

---

### Task 1: Settings, dependency pin, env plumbing

**Files:**
- Modify: `backend/app/config.py`
- Modify: `backend/requirements.txt` (+`langgraph==1.2.12`)
- Modify: `.env.example`, `docker-compose.yml`

**Interfaces:**
- Produces: `Settings.openrouter_api_key: SecretStr|None`, `openrouter_base_url: str = "https://openrouter.ai/api/v1"`, `openrouter_model: str = "openai/gpt-6-luna"`, `tavily_api_key: SecretStr|None`, `smartcv_fake_importer: bool = False`, `import_fetch_timeout: float = 15.0`, `import_llm_timeout: float = 90.0`, `import_max_chars: int = 40_000`, `import_min_source_chars: int = 800`.

- [ ] **Step 1: Failing test** — extend `backend/tests/test_health.py`-adjacent: create `backend/tests/test_config.py`

```python
from backend.app.config import Settings


def test_import_settings_defaults():
    settings = Settings(_env_file=None)
    assert settings.openrouter_api_key is None
    assert settings.openrouter_model == "openai/gpt-6-luna"
    assert settings.smartcv_fake_importer is False
    assert settings.import_min_source_chars == 800
```

- [ ] **Step 2:** Run `backend/.venv/Scripts/python -m pytest backend/tests/test_config.py -q` → FAIL (no such attrs).
- [ ] **Step 3:** Add fields to `Settings` in `config.py`; add `langgraph==1.2.12` to `requirements.txt`; `backend/.venv/Scripts/python -m pip install langgraph==1.2.12`; append env names to `.env.example`; add `OPENROUTER_API_KEY`/`OPENROUTER_BASE_URL`/`OPENROUTER_MODEL`/`TAVILY_API_KEY`/`SMARTCV_FAKE_IMPORTER` passthrough lines to `docker-compose.yml` `environment:`.
- [ ] **Step 4:** Re-run test → PASS.
- [ ] **Step 5:** Commit `git add -A && git commit -m "Add import agent settings and langgraph dependency"`.

---

### Task 2: CamelCase API schemas for openings domain

**Files:**
- Modify: `backend/app/schemas.py` (near-total rewrite of models)
- Test: `backend/tests/test_schemas.py`

**Interfaces:**
- Produces (all `ApiModel` = `BaseModel` + `ConfigDict(alias_generator=to_camel, populate_by_name=True, use_enum_values=False)`):
  - Enums: `EmploymentType`, `WorkArrangement`, `OpeningStatus(DRAFT/OPEN/CLOSED)`, `SourceType(MANUAL/LINK/FILE)`, `CandidateDecision(UNDECIDED/SHORTLISTED/PASSED)`; keep `MatchStatus`, `CandidateStatus`.
  - `OpeningSource{type, url?, filename?}`; `Criterion{id,name,description="",weight 1-5,required=False,suggested_weight?,suggestion_confidence?}`; `CriterionInput{id,name,description=""}`.
  - `Opening{id,title,department="",location="",description="",employment_type?,work_arrangement?,experience_level?,education_level?,skills:list[str]|None,closes_at:date|None,source:OpeningSource,status:OpeningStatus=OPEN,criteria:list[Criterion],created_at:datetime,updated_at:datetime|None,candidates:int=0,pending_review:int=0}`.
  - `OpeningCreate{title req, + optional same fields, source?, status?, criteria:list[Criterion]=[]}`; `OpeningUpdate` (every field optional).
  - `CandidateFile{filename,url,mime_type,page_count?}`; `CriterionEvaluation{criterion_id,status,confidence,model_fraction,evidence_span_ids:list[str],rationale?,manual_fraction?,review_note?,reviewed_by?,reviewed_at?}`; `Candidate{id,opening_id,name,email?,file,status,upload_order,uploaded_at,evaluations,total_score?,is_final,decision,error_message?,retryable}`.
  - `ImportCriterion{name,description="",weight:int=3,required=False,suggested_weight?,suggestion_confidence?}`; `ImportDraft{title="",department="",location="",description="",employment_type?,work_arrangement?,experience_level?,education_level?,skills:list[str],closes_at:str|None,criteria:list[ImportCriterion],source:OpeningSource,warnings:list[str]}`.
  - `ImportLinkRequest{url:str}`; `CriteriaSuggestionRequest{title?,department?,location?,employment_type?,work_arrangement?,experience_level?,education_level?,description?,skills:list[str],existing_criteria:list[CriterionRef{ id,name}]}`; `SuggestedCriterion{name,description,suggested_weight:int,required:bool,confidence:float}`; `SkillSuggestion{skill,matched_criterion_id:str|None,criterion:SuggestedCriterion|None}`; `CriteriaSuggestionResponse{suggestions}`.
  - `DecisionUpdate{decision:CandidateDecision}`; `ReviewUpdate{match_level,review_note?}` (keep).
  - `OpeningSnapshot{opening:Opening,candidates:list[Candidate]}` (replaces `JobSnapshot`); `BatchUploadResponse{candidates:list[Candidate],total_count}`; keep `WeightSuggestion*` (snake_case internals fine — same ApiModel).

- [ ] **Step 1: Failing tests** — `backend/tests/test_schemas.py`:

```python
from backend.app.schemas import (
    Candidate, CandidateDecision, CandidateFile, CandidateStatus,
    CriteriaSuggestionRequest, EmploymentType, ImportDraft, Opening,
    OpeningCreate, OpeningSource, SourceType, WorkArrangement,
)


def test_opening_serializes_camel_case():
    opening = Opening(
        id="o1", title="Backend Engineer",
        employment_type=EmploymentType.FULL_TIME,
        work_arrangement=WorkArrangement.HYBRID,
        skills=["Python"], closes_at="2026-10-15",
        source=OpeningSource(type=SourceType.MANUAL),
        criteria=[], created_at="2026-09-29T00:00:00Z",
        candidates=2, pending_review=1,
    )
    data = opening.model_dump(mode="json", by_alias=True)
    assert data["employmentType"] == "full_time"
    assert data["pendingReview"] == 1
    assert data["source"] == {"type": "manual", "url": None, "filename": None}


def test_opening_create_parses_camel_case():
    body = OpeningCreate.model_validate({
        "title": "PM", "employmentType": "contract",
        "skills": ["Roadmaps"], "closesAt": "2026-11-01",
    })
    assert body.employment_type == EmploymentType.CONTRACT


def test_import_draft_defaults():
    draft = ImportDraft(
        source=OpeningSource(type=SourceType.LINK, url="https://x"),
    )
    assert draft.warnings == [] and draft.criteria == []


def test_criteria_suggestion_request():
    req = CriteriaSuggestionRequest.model_validate({
        "title": "FE", "skills": ["React"],
        "existingCriteria": [{"id": "a", "name": "A"}],
    })
    assert req.existing_criteria[0].id == "a"


def test_candidate_shape():
    c = Candidate(
        id="c", opening_id="o", name="Jane", email=None,
        file=CandidateFile(filename="j.pdf", url="/api/x", mime_type="application/pdf"),
        status=CandidateStatus.COMPLETE, upload_order=0,
        uploaded_at="2026-09-29T00:00:00Z", evaluations=[],
        total_score=88.0, is_final=True,
        decision=CandidateDecision.UNDECIDED, retryable=False,
    )
    data = c.model_dump(mode="json", by_alias=True)
    assert data["openingId"] == "o" and data["isFinal"] is True
    assert data["file"]["mimeType"] == "application/pdf"
```

- [ ] **Step 2:** Run pytest on the new file → FAIL (imports missing).
- [ ] **Step 3:** Rewrite `schemas.py` per interfaces above (`from pydantic import BaseModel, ConfigDict, Field; from pydantic.alias_generators import to_camel`; `datetime`, `date` imports). `closes_at: date | None` on `Opening`/`OpeningCreate`; `str | None` on `ImportDraft.closes_at` (agent returns loose text — normalize best-effort).
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `git commit -m "Add camelCase openings domain schemas"`.

---

### Task 3: SQLite migration + repository for openings/candidates/decisions

**Files:**
- Modify: `backend/app/database.py` (schema + repository rewrite)
- Test: `backend/tests/test_repository.py` (new; covers migration + new methods)

**Interfaces:**
- Consumes: Task 2 models.
- Produces (method names later tasks use):
  - `create_opening(opening_id: str, data: OpeningCreate) -> None`
  - `list_openings() -> list[Opening]`, `get_opening(opening_id) -> Opening | None`, `opening_exists(id) -> bool`
  - `update_opening(opening_id, patch: OpeningUpdate) -> Opening | None` (criteria replaced wholesale when `patch.criteria is not None`; sets `updated_at`)
  - `add_candidates(opening_id, items: Iterable[Mapping])`, `list_candidates(opening_id) -> list[Candidate]`, `get_candidate(candidate_id) -> CandidateWorkItem | None` (work item gains `opening_id` field name), `get_candidate_result(candidate_id) -> Candidate | None`
  - `save_source_spans(candidate_id, preview_path, spans, *, name, email, page_count, mime_type)`; `set_candidate_status`, `save_candidate_result`, `mark_candidate_needs_review`, `mark_candidate_failed`, `reset_candidate_for_retry`
  - `update_manual_evaluation(candidate_id, criterion_id, manual_fraction, review_note, reviewed_by) -> Candidate | None`
  - `update_decision(candidate_id, decision) -> Candidate | None`
  - `candidate_counts(opening_id) -> (done, total)`, `pending_review_count(opening_id) -> int`
  - `get_opening_snapshot(opening_id) -> OpeningSnapshot | None` (`{opening, candidates}`)
  - `CandidateWorkItem` gains nothing else; `opening` replaces `job` in method names.

Schema `_SCHEMA` (fresh DBs):

```sql
CREATE TABLE IF NOT EXISTS openings (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, department TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
  employment_type TEXT, work_arrangement TEXT, experience_level TEXT,
  education_level TEXT, skills_json TEXT, closes_at TEXT,
  source_type TEXT NOT NULL DEFAULT 'manual', source_url TEXT, source_filename TEXT,
  status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT,
  is_final INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS criteria (
  opening_id TEXT NOT NULL REFERENCES openings(id), criterion_id TEXT NOT NULL,
  name TEXT NOT NULL, description TEXT NOT NULL, weight INTEGER NOT NULL,
  required INTEGER NOT NULL DEFAULT 0, suggested_weight INTEGER,
  suggestion_confidence REAL, position INTEGER NOT NULL,
  PRIMARY KEY (opening_id, criterion_id)
);
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY, opening_id TEXT NOT NULL REFERENCES openings(id),
  filename TEXT NOT NULL, stored_path TEXT NOT NULL, preview_path TEXT,
  name TEXT, email TEXT, mime_type TEXT, page_count INTEGER,
  decision TEXT NOT NULL DEFAULT 'undecided', uploaded_at TEXT,
  upload_order INTEGER NOT NULL, status TEXT NOT NULL, total_score REAL,
  error_message TEXT, retryable INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS evidence_spans (
  candidate_id TEXT NOT NULL REFERENCES candidates(id), span_id TEXT NOT NULL,
  page_number INTEGER NOT NULL, text TEXT NOT NULL, position INTEGER NOT NULL,
  PRIMARY KEY (candidate_id, span_id)
);
CREATE TABLE IF NOT EXISTS evaluations (
  candidate_id TEXT NOT NULL REFERENCES candidates(id), criterion_id TEXT NOT NULL,
  status TEXT NOT NULL, confidence REAL NOT NULL, model_fraction REAL NOT NULL,
  evidence_span_ids TEXT, rationale TEXT, manual_fraction REAL, review_note TEXT,
  reviewed_by TEXT, reviewed_at TEXT,
  PRIMARY KEY (candidate_id, criterion_id)
);
```

Migration `_migrate()` after `executescript(_SCHEMA)`:
- If `jobs` table exists and `openings` was just created empty → `INSERT INTO openings (id,title,is_final) SELECT id,title,is_final FROM jobs` then `DROP TABLE jobs`; reparent `criteria.job_id`/`candidates.job_id` by recreating those tables when they lack `opening_id` (demo data: simplest is `ALTER TABLE … RENAME COLUMN job_id TO opening_id` — SQLite ≥3.25 supports it).
- `PRAGMA table_info(<t>)` per table; `ALTER TABLE ADD COLUMN`/`RENAME COLUMN` for missing/new names (`evaluations.evidence_span_id` → `evidence_span_ids`, then `UPDATE … SET evidence_span_ids = '["' || evidence_span_ids || '"]' WHERE evidence_span_ids IS NOT NULL AND substr(evidence_span_ids,1,1) != '['`).

Candidate `file.url` is derived in `get_candidate_result`: `/api/openings/{opening_id}/candidates/{id}/preview` when `preview_path` set else `""`, `mimeType`/`pageCount` from columns (default `application/pdf` when preview exists).

`name`/`email` are written by `save_source_spans` (extraction-time). `is_final` = `status == complete`. `uploaded_at` set on insert (`datetime.now(timezone.utc).isoformat()`).

- [ ] **Step 1: Failing test** `backend/tests/test_repository.py`:

```python
import pytest
from backend.app.config import Settings
from backend.app.database import SQLiteRepository
from backend.app.schemas import (
    CandidateDecision, Criterion, EmploymentType, OpeningCreate,
    OpeningUpdate, SourceType, OpeningSource,
)


@pytest.fixture
async def repo(tmp_path):
    r = SQLiteRepository(tmp_path / "t.sqlite3")
    await r.open()
    yield r
    await r.close()


async def test_create_and_get_opening_roundtrip(repo):
    await repo.create_opening("o1", OpeningCreate(
        title="Backend Engineer", department="Engineering",
        employment_type=EmploymentType.FULL_TIME, skills=["Python"],
        source=OpeningSource(type=SourceType.LINK, url="https://x"),
        criteria=[Criterion(id="py", name="Python", description="d",
                            weight=4, required=True,
                            suggested_weight=5, suggestion_confidence=0.8)],
    ))
    opening = await repo.get_opening("o1")
    assert opening.title == "Backend Engineer"
    assert opening.employment_type == EmploymentType.FULL_TIME
    assert opening.source.url == "https://x"
    assert opening.criteria[0].required is True
    assert opening.criteria[0].suggested_weight == 5
    assert opening.candidates == 0


async def test_list_openings_counts(repo):
    await repo.create_opening("o1", OpeningCreate(title="A"))
    await repo.add_candidates("o1", [
        {"id": "c1", "filename": "a.pdf", "stored_path": "/x", "upload_order": 0},
        {"id": "c2", "filename": "b.pdf", "stored_path": "/y", "upload_order": 1},
    ])
    await repo.mark_candidate_needs_review("c2", "check")
    openings = await repo.list_openings()
    assert openings[0].candidates == 2
    assert openings[0].pending_review == 1


async def test_update_opening_and_decision(repo):
    await repo.create_opening("o1", OpeningCreate(title="A"))
    updated = await repo.update_opening(
        "o1", OpeningUpdate(title="B", status="closed"))
    assert updated.title == "B" and updated.status == "closed"
    assert updated.updated_at is not None
    await repo.add_candidates("o1", [
        {"id": "c1", "filename": "a.pdf", "stored_path": "/x", "upload_order": 0}])
    cand = await repo.update_decision("c1", CandidateDecision.SHORTLISTED)
    assert cand.decision == CandidateDecision.SHORTLISTED
```

Plus a migration test: build an old-schema DB (create `jobs`/`criteria`/`candidates`/`evaluations` with old columns, one job row), `await repo.open()`, assert `get_opening` finds it and new columns exist (`PRAGMA table_info(openings)` has `employment_type`).

- [ ] **Step 2:** Run → FAIL (`create_opening` missing).
- [ ] **Step 3:** Rewrite `database.py`: new `_SCHEMA`, `_migrate()`, renamed repository methods (`job_*` → `opening_*`, `get_job_snapshot` → `get_opening_snapshot`). Keep `SQLiteRepository.open/close/db`, `_write_lock`.
- [ ] **Step 4:** Run → PASS (new file). Old tests will fail — fixed in Task 5.
- [ ] **Step 5:** Commit `git commit -m "Migrate repository to openings domain"`.

---

### Task 4: Openings CRUD + import/criteria-suggestion endpoints skeleton

**Files:**
- Modify: `backend/app/api.py` — replace jobs routes; add `GET /api/openings`, `POST`, `GET/{id}`, `PATCH/{id}`.
- Modify: `backend/app/main.py` — `app.state.importer` (+`importer_override`), `create_importer` import.
- Test: `backend/tests/test_openings_api.py`

**Interfaces:**
- Consumes: Task 3 repository; Task 2 models.
- Produces: route paths used by frontend — `POST/GET /api/openings`, `GET/PATCH /api/openings/{id}`; `app.state.importer`, `app.state.evaluator` already exist.

- [ ] **Step 1: Failing test** `test_openings_api.py` (mirror `test_api.py` fixtures — `settings`/`app`/`client` with `smartcv_fake_evaluator=True`):

```python
def test_create_list_get_update_opening(client):
    resp = client.post("/api/openings", json={
        "title": "Backend Engineer", "department": "Engineering",
        "employmentType": "full_time", "skills": ["Python"],
        "criteria": [{"id": "py", "name": "Python", "weight": 4,
                      "required": True}],
    })
    assert resp.status_code == 201
    opening = resp.json()
    assert opening["employmentType"] == "full_time"
    assert opening["candidates"] == 0
    oid = opening["id"]

    listed = client.get("/api/openings").json()
    assert [o["id"] for o in listed] == [oid]

    got = client.get(f"/api/openings/{oid}").json()
    assert got["criteria"][0]["required"] is True

    patched = client.patch(f"/api/openings/{oid}",
                           json={"title": "Senior BE", "status": "closed"})
    assert patched.status_code == 200
    assert patched.json()["status"] == "closed"

    assert client.get("/api/openings/nope").status_code == 404


def test_create_opening_requires_title(client):
    assert client.post("/api/openings", json={}).status_code == 422
```

- [ ] **Step 2:** Run → FAIL (404s).
- [ ] **Step 3:** In `api.py` replace `/jobs` POST/GET with openings routes (`uuid.uuid4().hex` ids; `create_opening`; list; get; patch). Keep `/weight-suggestions`. In `main.py` lifespan add `importer = create_importer(settings, active_evaluator)` — define `create_importer` in Task 7; for now guard: `app.state.importer = None` replaced in Task 7. Simpler: add `app.state.importer_override = importer` param wiring now, call `create_importer` lazily inside Task 7's routes via `request.app.state.importer`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `git commit -m "Add openings CRUD endpoints"`.

---

### Task 5: Candidate pipeline upgrades + SSE renames

**Files:**
- Modify: `backend/app/api.py` (candidates routes under openings), `backend/app/worker.py`, `backend/app/events.py`, `backend/app/documents.py` (extract name/email/page_count; bbox on spans)
- Test: `backend/tests/test_candidates_api.py`, update `test_api.py`, `test_batch_flow.py`, `test_worker.py`, `test_events.py`

**Interfaces:**
- Produces: `POST /api/openings/{id}/candidates` (multipart, `.pdf`/`.docx` only), `GET …/candidates`, `GET …/events` SSE (`snapshot` `{opening,candidates}`, `candidate.updated` `{candidate, completedCount,totalCount}`, `opening.progress`, `opening.complete`), `GET …/preview`, `GET …/spans` (spans gain optional `bbox`), `PATCH …/criteria/{cid}` (+`reviewedBy`/`reviewedAt`), `PATCH …/decision`, `POST …/retry`.
- `documents.py`: `ParsedDocument` gains `page_count:int`; new `extract_identity(spans) -> (name|None, email|None)` — first `_EMAIL` match for email; name = first page-1 non-empty line ≤60 chars with ≥2 alpha words and no `@`, else None (worker falls back to filename-stem title-case). `EvidenceSpan` gains `bbox: dict | None` from pymupdf `block[:4]` `{x: x0, y: y0, width: x1-x0, height: y1-y0}`.
- `auth.py`: add public `current_username(request) -> str` (session username or `"local"`).

- [ ] **Step 1: Failing tests** — `test_candidates_api.py` (reuse `pdf_bytes` helper from `test_api.py`):

```python
def test_upload_and_snapshot_candidates(client):
    oid = make_opening(client)
    resp = client.post(f"/api/openings/{oid}/candidates", files=[
        ("files", ("jane-doe-cv.pdf", pdf_bytes(
            "Jane Doe\njane@example.com\nBuilt python services"), "application/pdf")),
    ])
    assert resp.status_code == 201
    cand = resp.json()["candidates"][0]
    assert cand["status"] in {"queued", "extracting", "evaluating",
                              "complete", "needs_review"}
    listed = client.get(f"/api/openings/{oid}/candidates").json()
    assert listed[0]["openingId"] == oid
    assert listed[0]["file"]["mimeType"] == "application/pdf"
    assert listed[0]["decision"] == "undecided"


def test_decision_and_review(client):
    oid = make_opening(client)
    client.post(f"/api/openings/{oid}/candidates", files=[
        ("files", ("a.pdf", pdf_bytes("python postgresql production"), "application/pdf"))])
    cand = client.get(f"/api/openings/{oid}/candidates").json()[0]
    # fake evaluator completes quickly — wait via SSE snapshot or poll
    cid = cand["id"]
    r = client.patch(f"/api/openings/{oid}/candidates/{cid}/decision",
                     json={"decision": "shortlisted"})
    assert r.json()["decision"] == "shortlisted"
```

(Eventually-consistent statuses: poll `GET …/candidates` until `status` terminal or timeout in tests, as existing `test_batch_flow.py` does — read it for the established wait pattern.)

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Move upload/preview/spans/review/retry routes under `/openings`; add `GET …/candidates`, `PATCH …/decision`; pass `reviewed_by=current_username(request)`; rename events `job.*` → `opening.*`, snapshot payload `{opening, candidates}` via `get_opening_snapshot`. Worker: after `parse_cv`, call `extract_identity`, pass name/email/page_count/mime_type to `save_source_spans`; filename-stem fallback for name. Update `update_manual_evaluation` call signature.
- [ ] **Step 4:** Run whole suite → fix stragglers (`test_api.py` job paths → openings; `JobSnapshot` → `OpeningSnapshot`).
- [ ] **Step 5:** Commit `git commit -m "Move candidate pipeline under openings with decisions and identity extraction"`.

---

### Task 6: Criteria suggestions (Jev) + endpoint

**Files:**
- Modify: `backend/app/typesafe_adapter.py` (`suggest_criteria` on both evaluators)
- Modify: `backend/app/api.py` (`POST /api/criteria-suggestions`)
- Test: `backend/tests/test_criteria_suggestions.py`

**Interfaces:**
- Produces: `evaluator.suggest_criteria(request: CriteriaSuggestionRequest) -> list[SkillSuggestion]`; endpoint returns `CriteriaSuggestionResponse`.
- `TypeSafeEvaluator.suggest_criteria`: state `{role: {…non-null request fields…}, skills, existingCriteria}`; per skill `s` questions — `match_{i}` Choice over `{c.id: c.name for existing} + {"new": "No existing criterion covers this skill"}`; `weight_{i}` Score `_WEIGHT_LEVELS`; `required_{i}` Noul ("A CV with no evidence of this skill fails a core, non-negotiable requirement of the role." — check installed `typesafe_sdk.Noul` signature: `inspect.signature(Noul.__init__)` and `result.nouls` shape; mirror how `Score`/`Choice` results are read).
- Mapping: match `"new"` → `SuggestedCriterion{name=skill.strip().title()-ish (preserve original casing trimmed), description=f"Evidence of {skill} relevant to this role.", suggested_weight=score+1 clamped 1-5, required=noul.yes_probability>=0.6, confidence=min(confidences)}`; else `matched_criterion_id=choice`, criterion=None.
- `FakeEvaluator.suggest_criteria`: every skill → `new`, `suggested_weight=3`, `required=False`, `confidence=1.0`.

- [ ] **Step 1: Failing test**:

```python
def test_criteria_suggestions_returns_suggestions(client):
    resp = client.post("/api/criteria-suggestions", json={
        "title": "Frontend Engineer", "skills": ["React", "GraphQL"],
        "existingCriteria": [{"id": "react", "name": "React experience"}],
    })
    assert resp.status_code == 200
    suggestions = {s["skill"]: s for s in resp.json()["suggestions"]}
    assert suggestions["React"]["criterion"]["suggestedWeight"] == 3
    assert suggestions["GraphQL"]["matchedCriterionId"] is None


def test_criteria_suggestions_empty_skills(client):
    resp = client.post("/api/criteria-suggestions",
                       json={"skills": [], "existingCriteria": []})
    assert resp.status_code == 200 and resp.json()["suggestions"] == []
```

- [ ] **Step 2:** Run → FAIL (404).
- [ ] **Step 3:** Implement `suggest_criteria` on both evaluators + route (empty `skills` short-circuits before evaluator call).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `git commit -m "Add Jev skill-to-criteria suggestions endpoint"`.

---

### Task 7: Listing import agent (LangGraph + OpenRouter + Tavily)

**Files:**
- Create: `backend/app/importer.py`
- Modify: `backend/app/api.py` (`POST /api/openings/import/link`, `POST /api/openings/import/file`), `backend/app/main.py` (lifespan wiring `app.state.importer`, `importer_override` param)
- Test: `backend/tests/test_importer.py`, `backend/tests/test_import_api.py`

**Interfaces:**
- Produces:
  - `class ImportSource` — `link(url:str)` / `file(path:Path, filename:str, mime:str)` (small dataclass or TypedDict).
  - `async def import_listing(self, source) -> ImportDraft` on `ListingImporter` (protocol), `LangGraphImporter`, `FakeImporter`.
  - `create_importer(settings, evaluator) -> (importer, httpx.AsyncClient | None)` mirroring `create_evaluator`.
  - Errors: `ImporterUnavailable` (503), `ListingNotReadable` (422), `ImportProviderError` (502).
  - `main.create_app(settings=None, evaluator=None, importer=None)`.

Graph (TypedDict `ImportState{source_type, url, file_path, filename, mime, source_text, binary_parts: list[dict], warnings: list[str], draft: dict|None}`):

```python
from langgraph.graph import END, START, StateGraph

builder = StateGraph(ImportState)
builder.add_node("gather", _gather)
builder.add_node("search", _search)
builder.add_node("extract", _extract)
builder.add_node("weights", _weights)
builder.add_edge(START, "gather")
builder.add_conditional_edges("gather", _needs_search,
                              {"search": "search", "extract": "extract"})
builder.add_edge("search", "extract")
builder.add_edge("extract", "weights")
builder.add_edge("weights", END)
graph = builder.compile()
```

- `_gather`: link → `httpx` GET (`headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SmartCV/1.0"}`, `follow_redirects=True`, `timeout=settings.import_fetch_timeout`); strip html: remove `<script|style|noscript>…</…>` blocks, strip tags, `html.unescape`, collapse whitespace, truncate `import_max_chars`. file → `.pdf` `pymupdf` text (if < min chars → `binary_parts` file part), `.docx` `python-docx` paragraphs, `image/*` → base64 `image_url` part, else 415.
- `_needs_search(state)`: `"search"` if `len(source_text) < settings.import_min_source_chars and settings.tavily_api_key` else `"extract"`.
- `_search`: `POST https://api.tavily.com/search` `{api_key, query: f"{url or filename} job posting", max_results: 5, search_depth: "basic"}`; append `r["content"]`s; `warnings += ["Fetched page was thin or blocked; filled from web search results."]`. HTTP errors → warning only, continue to extract.
- `_extract`: OpenRouter `POST {base}/chat/completions` `{model, messages, response_format:{type:"json_schema", json_schema:{name:"opening_draft", strict:True, schema: OPENING_DRAFT_SCHEMA}}, max_tokens: 4000}`. System prompt: extract job-ad fields; enums verbatim; `closesAt` ISO date or null; `criteria` = 3–8 items `{name, description, required}` — what a CV screener should verify; `skills` flat strings; empty/`null` when unknown. User message = `[{"type":"text","text": <source_text or "Extract the job ad from the attached file.">}] + binary_parts`. Parse `choices[0].message.content` JSON → dict; on parse/HTTP failure → `ImportProviderError`. If `source_text` empty AND no binary parts → `ListingNotReadable`.
- `_weights`: `evaluator.suggest_weights([CriterionInput(id=slug, name, description)])` → merge `suggestedWeight`/`suggestionConfidence`, `weight=suggested`; on `Exception` → `warnings += ["Weight suggestions unavailable; defaulting to 3."]`, `weight=3`.
- `OPENING_DRAFT_SCHEMA` (JSON schema, `additionalProperties: false`): required `title`; nullable `department,location,description,employmentType(enum),workArrangement(enum),experienceLevel,educationLevel,closesAt`; `skills: string[]`; `criteria: [{name req, description, required bool}]`.

`FakeImporter`: returns `ImportDraft(title=<host or filename stem>, description="Imported listing (offline stub).", skills=["Example skill"], criteria=[ImportCriterion(name="Example criterion", suggested_weight=3, suggestion_confidence=1.0, weight=3)], source=…, warnings=["Fake importer used — no live extraction."])`.

Endpoints: `POST /api/openings/import/link` body `ImportLinkRequest` → `importer.import_listing(link(url))`; `POST …/import/file` `UploadFile` → suffix check `{.pdf,.docx,.png,.jpg,.jpeg,.webp}` + size ≤ `max_file_bytes`, save to temp under `data_dir/import-tmp` (cleanup after call), call importer. Map errors: `ImporterUnavailable`→503, `ListingNotReadable`→422, `ImportProviderError`→502. `importer is None` → 503.

`main.py`: `create_app(settings=None, evaluator=None, importer=None)`; lifespan: `if app.state.importer_override is not None: active_importer, import_client = override, None else: active_importer, import_client = create_importer(settings, active_evaluator)`; close `import_client` on shutdown. `create_importer` returns `(FakeImporter(), None)` when `smartcv_fake_importer`, `(LangGraphImporter(settings, evaluator, client), client)` when key set, else `(None, None)` — endpoints 503.

- [ ] **Step 1: Failing tests** — `test_importer.py` with `httpx.MockTransport`:

```python
LISTING_HTML = b"<html><body><h1>Senior Backend Engineer</h1><p>Python, FastAPI…" + b"x" * 900 + b"</p></body></html>"


async def test_link_import_happy_path():
    calls = []

    def handler(request):
        calls.append(str(request.url))
        if "openrouter" in str(request.url):
            return httpx.Response(200, json={
                "choices": [{"message": {"content": json.dumps({
                    "title": "Senior Backend Engineer",
                    "department": "Engineering", "location": "Jakarta",
                    "description": "Build APIs", "employmentType": "full_time",
                    "workArrangement": "hybrid", "experienceLevel": "5+ years",
                    "educationLevel": None, "closesAt": "2026-10-15",
                    "skills": ["Python", "FastAPI"],
                    "criteria": [{"name": "Python", "description": "d",
                                  "required": True}],
                })}}]})
        return httpx.Response(200, content=LISTING_HTML)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    settings = Settings(_env_file=None, openrouter_api_key="k",
                        tavily_api_key="k")
    importer = LangGraphImporter(settings, FakeEvaluator(), client)
    draft = await importer.import_listing(ImportSource.link("https://jobstreet.example/job/1"))
    assert draft.title == "Senior Backend Engineer"
    assert draft.criteria[0].suggested_weight == 3  # FakeEvaluator
    assert draft.source.url == "https://jobstreet.example/job/1"
    assert not any("search" in c for c in calls)  # thick page → no tavily


async def test_thin_page_falls_back_to_tavily():
    def handler(request):
        url = str(request.url)
        if "tavily" in url:
            return httpx.Response(200, json={"results": [
                {"content": "Backend Engineer at X. Python. Hybrid Jakarta." * 40}]})
        if "openrouter" in url:
            return httpx.Response(200, json={"choices": [{"message": {"content":
                json.dumps({"title": "Backend Engineer", "skills": ["Python"],
                            "criteria": []})}}]})
        return httpx.Response(403, content=b"blocked")
    …assert draft.warnings has the search-fallback warning…


async def test_nothing_readable_raises():
    # fetch 403 + tavily empty + no binary → ListingNotReadable
```

`test_import_api.py` (TestClient + `importer=FakeImporter()` override — extend `create_app` to accept it):

```python
def test_import_link_endpoint(client):  # fixture passes importer=FakeImporter()
    resp = client.post("/api/openings/import/link",
                       json={"url": "https://jobstreet.example/job/1"})
    assert resp.status_code == 200
    assert resp.json()["source"]["type"] == "link"
    assert resp.json()["criteria"][0]["suggestedWeight"] == 3


def test_import_file_endpoint(client, tmp_path):
    resp = client.post("/api/openings/import/file", files=[
        ("file", ("ad.pdf", pdf_bytes("Backend Engineer…"), "application/pdf"))])
    assert resp.status_code == 200 and resp.json()["source"]["filename"] == "ad.pdf"


def test_import_unconfigured(monkeypatch, tmp_path):
    # create_app with no override and no keys → 503
```

- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3:** Implement `importer.py`, routes, `main.py` wiring.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `git commit -m "Add LangGraph listing importer with OpenRouter and Tavily fallback"`.

---

### Task 8: Frontend API layer + openings store

**Files:**
- Create: `frontend/src/lib/api.ts`
- Rewrite: `frontend/src/lib/openings.tsx` (API-backed store)
- Modify: `frontend/src/App.tsx` (`getOpening` → async-safe lookup via store), `manual-opening-form.tsx`, `new-opening-dialog.tsx` (async onSubmit)
- Test: `frontend/src/lib/api.test.ts`, `frontend/src/lib/openings.test.tsx`

**Interfaces:**
- Produces:
  - `apiFetch<T>(path, init?)` — throws `Error(detail)` on !ok (same pattern as `lib/auth.ts`).
  - `openingsApi.list(): Promise<OpeningApi[]>`, `.create(input: NewOpeningInput & {source?}): Promise<OpeningApi>`, `.update(id, input)`, `.importLink(url): Promise<ImportDraft>`, `.importFile(file): Promise<ImportDraft>` (FormData), `.suggestCriteria(req): Promise<CriteriaSuggestionResponse>`.
  - `useOpenings(): Opening[]` (unchanged signature), `getOpening(id)`, `addOpening(input): Promise<Opening>` (now async), `updateOpening(id, input): Promise<void>`.
  - Icon mapping client-side: `department` contains "engineer"→`CodeIcon`, "design"→`PenToolIcon`, "data"→`ChartColumnIcon`, "manage/lead"→`UsersIcon`, "backend"→`ServerIcon`, else `BriefcaseIcon`. `url = /openings/${id}`.
- Store: module-level `openings[]` + `loaded` flag; `useOpenings` triggers `refreshOpenings()` on first subscribe; mutations `await` the API then `await refreshOpenings()`. `useSyncExternalStore` stays.

- [ ] **Step 1: Failing test** `frontend/src/lib/openings.test.tsx` — mock `fetch` with `vi.stubGlobal`, assert `addOpening` POSTs `/api/openings` with camelCase body and store updates:

```tsx
it("addOpening posts to the api and exposes the opening", async () => {
  const payload = { id: "x", title: "PM", department: "", location: "",
    description: "", source: { type: "manual" }, status: "open",
    criteria: [], createdAt: "2026-09-29T00:00:00Z",
    candidates: 0, pendingReview: 0 };
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 201 }))
    .mockResolvedValueOnce(new Response(JSON.stringify([payload]), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const opening = await addOpening({ title: "PM" });
  expect(fetchMock.mock.calls[0][0]).toBe("/api/openings");
  expect(opening.id).toBe("x");
});
```

(Also `api.test.ts`: `apiFetch` unwraps `{detail}` errors.)

- [ ] **Step 2:** `npm run test -- --run` → FAIL.
- [ ] **Step 3:** Implement `lib/api.ts`; rewrite `lib/openings.tsx` (keep `Opening`, `NewOpeningInput`, `NewCriterionInput`, `EMPLOYMENT_TYPE_LABELS`, `WORK_ARRANGEMENT_LABELS`, `openingMeta`, `slugify` for criterion ids; `buildCriteria` stays — but criteria gain `suggestedWeight` passthrough). Update `manual-opening-form.tsx` `submit` → `await onSubmit(...)`; `onSubmit` type `(input) => void | Promise<void>`; `new-opening-dialog` `done()` unchanged (called after await).
- [ ] **Step 4:** Tests PASS + `npm run build`.
- [ ] **Step 5:** Commit `git commit -m "Wire openings store to backend API"`.

---

### Task 9: Candidates store + SSE + dialogs

**Files:**
- Rewrite: `frontend/src/lib/candidates.ts`
- Modify: `frontend/src/components/add-candidates-dialog.tsx`, `frontend/src/pages/opening-detail.tsx` (accept `.pdf,.docx`), `frontend/src/components/import-opening-form.tsx` (real calls + error state)
- Test: `frontend/src/lib/candidates.test.tsx`

**Interfaces:**
- Produces: `useCandidates(openingId): Candidate[]` (fetch `GET /api/openings/{id}/candidates` + `EventSource(/api/openings/{id}/events)`; apply `snapshot.candidates` + `candidate.updated.candidate`; close on `opening.complete`/unmount); `addCandidates(openingId, files): Promise<void>` (multipart `files[]` → POST; then rely on SSE/fetch refresh); `setDecision`, `retryCandidate`, `reviewCriterion` helpers for the API.
- `import-opening-form`: `importLink`/`importFiles` → `await openingsApi.importLink/…`; `catch` → `setError(message)` + back to form; error line under the dropzone (`<p className="text-xs text-destructive">`).

- [ ] **Step 1: Failing test** `candidates.test.tsx`: stub `fetch` + a fake `EventSource` class (jsdom lacks it) capturing URL; assert list fetch path `/api/openings/o1/candidates` and that a dispatched `candidate.updated` message updates the hook value (wrap in `act`).

```tsx
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, (e: MessageEvent) => void>();
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(n: string, f: any) { this.listeners.set(n, f); }
  close() {}
}
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `lib/candidates.ts` rewrite; update dialogs/dropzones `accept=".pdf,.docx"`; real import calls in `import-opening-form.tsx`.
- [ ] **Step 4:** PASS + `npm run build` + `npm run lint`.
- [ ] **Step 5:** Commit `git commit -m "Wire candidates, SSE and import forms to backend"`.

---

### Task 10: Debounced skill→criteria suggestions in ManualOpeningForm

**Files:**
- Modify: `frontend/src/components/manual-opening-form.tsx`
- Test: `frontend/src/components/manual-opening-form.test.tsx`

**Interfaces:**
- `mergeSuggestions(criteria: NewCriterionInput[], suggestions: SkillSuggestion[]): NewCriterionInput[]` — pure exported helper (append `{name, weight: suggestedWeight, required}` for `matchedCriterionId == null` whose name isn't already a criterion); unit-testable.
- Form effect: `useEffect` on `skills` → `setTimeout(600ms)` → parse + filter already-suggested (ref `Set`, lowercase) + existing criterion names → `openingsApi.suggestCriteria({title, department, location, employmentType, workArrangement, experienceLevel, educationLevel, description, skills: pending, existingCriteria: criteria-name pairs})` → `setCriteria(merge)`. Guard: abort if `skills` unchanged since request started; catch → silent (suggestions are best-effort).

- [ ] **Step 1: Failing test** — `mergeSuggestions` unit test (dedupe by name, maps weight/required) + component test with `vi.useFakeTimers()` + stubbed `openingsApi.suggestCriteria`: type "GraphQL" → advance 700ms → criteria row appears.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement helper + effect.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `git commit -m "Add debounced Jev skill suggestions to opening form"`.

---

### Task 11: Docs + full verification

**Files:**
- Modify: `README.md` (route names `/api/openings/*`, import env vars, fake importer note), `.env.example` comments
- Verify: whole backend suite, frontend test+build+lint

- [ ] **Step 1:** Update README "Frontend" + run sections: `OPENROUTER_API_KEY`, `TAVILY_API_KEY`, `OPENROUTER_MODEL=openai/gpt-6-luna`, `SMARTCV_FAKE_IMPORTER=true` for offline demos; `/api/openings` route names; image imports allowed only for listings.
- [ ] **Step 2:** `backend/.venv/Scripts/python -m pytest backend/tests -q` → all PASS.
- [ ] **Step 3:** `cd frontend && npm run test -- --run && npm run build && npm run lint` → clean.
- [ ] **Step 4:** Manual smoke (documented): `SMARTCV_FAKE_EVALUATOR=true SMARTCV_FAKE_IMPORTER=true uvicorn backend.app.main:app` + `npm run dev` → create opening manually, import via fake, upload a demo PDF, watch SSE update.
- [ ] **Step 5:** Commit `git commit -m "Document openings import and API wiring"`.

---

## Self-review notes

- Spec §3 endpoints ↔ Tasks 4/5/6/7; §4 importer ↔ Task 7; §5 ↔ Tasks 6/10; §6 ↔ Task 5; §7 ↔ Task 3; §8 ↔ Tasks 8/9/10; §9 ↔ Tasks 1/11; §10 ↔ tests in every task.
- `Opening.candidates` (count) vs `GET …/candidates` (list) — intentional split per spec; snapshot SSE payload `{opening, candidates}` keeps both.
- `OpeningUpdate.criteria` wholesale-replaces; dangling evaluations are hidden by the criteria join (acceptable for demo).
- `Noul` result accessor (`result.nouls`/`yes` probability field name) — verify against installed `typesafe_sdk 0.7.1` during Task 6 (`inspect.signature`, SDK source in `backend/.venv`).

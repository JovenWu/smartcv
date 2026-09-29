# SmartCV Openings Workspace — Backend Design

**Date:** 2026-09-29
**Status:** Approved by user
**Scope:** Demo-data MVP. Extends `docs/superpowers/specs/2026-09-29-smartcv-screening-design.md`; all its constraints still apply (no auto-rejection, no OCR for CVs, Jev never sees names/contacts, evidence stays verbatim + page-linked).

## 1. Goal

The rebuilt frontend (commit `aff3e16`) is a shadcn openings workspace whose data is entirely in-memory. This spec matches the backend to it so the full flow runs end-to-end:

- **Import a listing** — paste a job-board URL (Jobstreet, LinkedIn, Glints, …) or drop a PDF/screenshot/image/DOCX of the ad. A LangGraph agent (`openai/gpt-6-luna` via OpenRouter) gathers the listing content — direct fetch first, Tavily web search when blocked or thin — extracts structured role fields + candidate criteria, then Jev assigns suggested weights. The draft is returned for the manager to review/edit before anything is saved.
- **Enter manually** — while the reviewer types skills, a debounced call asks Jev to classify each skill against the role context: does it duplicate an existing criterion, how important is it (1–5), is it a hard requirement. Suggestions stream into the criteria list as editable rows.
- **Everything else wired** — openings CRUD, CV upload, SSE streaming, previews, criterion review, shortlist decisions.

## 2. Wire format

`frontend/src/types.ts` is the contract; responses serialize **camelCase** via a shared pydantic config (`alias_generator=to_camel`, `populate_by_name=True`) so Python stays snake_case.

### Opening

```json
{
  "id": "…", "title": "…", "department": "…", "location": "…",
  "description": "…",
  "employmentType": "full_time|part_time|contract|internship|casual",
  "workArrangement": "remote|hybrid|onsite",
  "experienceLevel": "3+ years", "educationLevel": "Bachelor's degree",
  "skills": ["React"], "closesAt": "2026-10-15",
  "source": {"type": "manual|link|file", "url": "…", "filename": "…"},
  "status": "draft|open|closed",
  "criteria": [Criterion],
  "createdAt": "…", "updatedAt": "…",
  "candidates": 5, "pendingReview": 1
}
```

`candidates`/`pendingReview` are computed counts server-side (total candidates; those in `needs_review`).

### Criterion

`{id, name, description, weight(1–5), required?, suggestedWeight?, suggestionConfidence?}`

### Candidate

```json
{
  "id", "openingId", "name", "email?",
  "file": {"filename", "url", "mimeType", "pageCount?"},
  "status": "queued|extracting|evaluating|complete|needs_review|failed",
  "uploadOrder": 0, "uploadedAt": "…",
  "evaluations": [{
    "criterionId", "status", "confidence", "modelFraction",
    "evidenceSpanIds": ["p1-b0"], "rationale?",
    "manualFraction?", "reviewNote?", "reviewedBy?", "reviewedAt?"
  }],
  "totalScore": 74.0, "isFinal": true,
  "decision": "undecided|shortlisted|passed",
  "errorMessage?", "retryable": false
}
```

- `name`: best-effort from extracted CV text — first plausible name line, else filename-derived (`jane-doe-cv.pdf` → `Jane Doe`). `email`: first email regex match in extracted text, else null. Both are convenience labels; they are still stripped from Jev state.
- `file.url` = `/api/openings/{id}/candidates/{cid}/preview` once a preview exists; `mimeType`/`pageCount` describe the rendered preview (always PDF once generated).
- `isFinal` = `status == "complete"` (needs_review stays provisional).
- `decision` is recruiter-owned; screening never sets it.

## 3. API surface

Existing `/api/jobs/*` routes move to `/api/openings/*`; internal `job` terminology is renamed to `opening` in schema/route names. Old routes are removed (the old frontend was deleted; tests are updated).

| Method & path | Body → Response |
|---|---|
| `POST /api/openings` | `OpeningCreate {title, department?, location?, description?, employmentType?, workArrangement?, experienceLevel?, educationLevel?, skills?, closesAt?, source?, status?, criteria[]}` → 201 `Opening` |
| `GET /api/openings` | → `Opening[]` (with counts) |
| `GET /api/openings/{id}` | → `Opening` |
| `PATCH /api/openings/{id}` | `OpeningUpdate` (same fields, all optional) → `Opening` |
| `POST /api/openings/import/link` | `{url}` → `ImportDraft` |
| `POST /api/openings/import/file` | multipart `file` → `ImportDraft` |
| `POST /api/criteria-suggestions` | `CriteriaSuggestionRequest` → `CriteriaSuggestionResponse` |
| `POST /api/openings/{id}/candidates` | multipart `files[]` → `BatchUploadResponse{candidates[], totalCount}` |
| `GET /api/openings/{id}/candidates` | → `Candidate[]` |
| `GET /api/openings/{id}/events` | SSE |
| `GET /api/openings/{id}/candidates/{cid}/preview` | PDF file |
| `GET /api/openings/{id}/candidates/{cid}/spans` | `EvidenceSpan[]` (now with optional `bbox {x,y,width,height}`) |
| `PATCH /api/openings/{id}/candidates/{cid}/criteria/{crit}` | `{matchLevel, reviewNote?}` → `Candidate` (sets `reviewedBy` = session user, `reviewedAt`) |
| `PATCH /api/openings/{id}/candidates/{cid}/decision` | `{decision}` → `Candidate` |
| `POST /api/openings/{id}/candidates/{cid}/retry` | → `Candidate` |
| `POST /api/weight-suggestions` | unchanged (Jev weight scoring for arbitrary criteria) |

### ImportDraft (response, not persisted)

```json
{
  "title": "…", "department": "…", "location": "…", "description": "…",
  "employmentType": "full_time", "workArrangement": "hybrid",
  "experienceLevel": "…", "educationLevel": "…",
  "skills": ["…"], "closesAt": "2026-10-15",
  "criteria": [{"name","description","weight","required","suggestedWeight","suggestionConfidence"}],
  "source": {"type": "link", "url": "…"} ,
  "warnings": ["Listing page blocked; filled from search results."]
}
```

Maps directly onto the frontend's `Partial<NewOpeningInput>` + `source`. `weight` is prefilled from `suggestedWeight` so the review form shows the agent's pick; the reviewer confirms by saving.

### CriteriaSuggestionRequest / Response

```json
// request
{
  "title": "…", "department": "…", "location": "…",
  "employmentType": "…", "workArrangement": "…",
  "experienceLevel": "…", "educationLevel": "…", "description": "…",
  "skills": ["react", "graphql"],
  "existingCriteria": [{"id": "react-experience", "name": "React experience"}]
}
// response
{
  "suggestions": [
    {"skill": "react", "matchedCriterionId": "react-experience", "criterion": null},
    {"skill": "graphql", "matchedCriterionId": null,
     "criterion": {"name": "GraphQL",
                   "description": "Evidence of GraphQL work relevant to this role.",
                   "suggestedWeight": 4, "required": false, "confidence": 0.82}}
  ]
}
```

The frontend appends a criteria row for each `matchedCriterionId == null` suggestion (weight ← `suggestedWeight`); matches are returned so the UI can skip duplicates without adding noise.

### SSE events (renamed)

`snapshot` (Opening + Candidate[]), `candidate.updated` {candidate}, `opening.progress` {completedCount,totalCount}, `opening.complete` {snapshot}.

## 4. Import agent — `backend/app/importer.py`

LangGraph `StateGraph` over plain async node functions; LLM access via `httpx.AsyncClient` to OpenRouter chat completions. No langchain-openai. Pin `langgraph==1.2.12` (2026-09-21, ≥7 days).

```
START → gather_source ──(thin or failed and tavily configured)──→ tavily_search → extract_draft
            └──(enough text or no tavily)─────────────────────────→ extract_draft → jev_weights → END
```

- **gather_source**
  - `link`: `httpx` GET the URL (browser UA, 15s timeout, ≤2 MB read). HTML stripped to text (tag strip + whitespace collapse); `<script>/<style>` dropped.
  - `file`: `.pdf` → pymupdf text; `.docx` → python-docx text; `image/*` → kept as base64 for a multimodal user message. A PDF with no extractable text is also forwarded as a file part to the model.
  - Produces `source_text` (may be empty) + optional binary parts.
- **tavily_search** — conditional edge when `len(source_text) < MIN_SOURCE_CHARS` (800) or fetch failed **and** `TAVILY_API_KEY` set. `POST https://api.tavily.com/search` `{query: <url or host + "job posting">, max_results: 5}`; concatenated `results[].content` appended to `source_text`; a `warnings` note records the fallback. If Tavily is unset, the edge is skipped and extraction runs on whatever was gathered (or fails cleanly).
- **extract_draft** — chat completion, `response_format: {"type":"json_schema", "json_schema": {...opening_draft}}`; system prompt fixes enum vocabularies (employmentType, workArrangement), null-when-unknown semantics, and "criteria = what a screener should verify in a CV" guidance. Source text is truncated to `IMPORT_MAX_CHARS` (40k). Output validates into `ImportDraft` (defaults: `weight=3` placeholder, `required=false` unless model says must-have).
- **jev_weights** — calls `evaluator.suggest_weights(criteria)`; merges `suggestedWeight`/`suggestionConfidence`, prefills `weight`. On Jev failure the draft is still returned with `weight=3` and a warning (imports must not be hostage to the scoring service).

**Errors**: unconfigured importer (no `OPENROUTER_API_KEY` and not fake) → 503 "Listing import is not configured". Fetch+search produced nothing → 422 "Couldn't read that listing". Provider failure → 502 `ImportError` detail, retryable by resubmitting. File uploads for import reuse size limits; unsupported types → 415.

**FakeImporter**: deterministic draft built from the URL host / filename for offline dev + tests (`SMARTCV_FAKE_IMPORTER=true`). Selected only explicitly — never a silent fallback.

**Privacy**: listing pages are public ads; still send only extracted text/image to OpenRouter, never session data. Keys stay server-side.

## 5. Skill → criteria classification (Jev)

`TypeSafeEvaluator.suggest_criteria(context)` → one `system_one` call:

- state: `{role: {title, department, location, employmentType, workArrangement, experienceLevel, educationLevel, description}, skills, existingCriteria}`
- per skill `s`: `match_s` **Choice** over `{existing criterion ids…, "new"}` ("which existing criterion already covers this skill?"); `weight_s` **Score** on `_WEIGHT_LEVELS`; `required_s` **Noul** ("a CV that shows no evidence of this skill would fail a core requirement").
- mapping: `matched` → `matchedCriterionId`; `new` → criterion `{name: TitleCased skill, description: template, suggestedWeight: score→1–5, required: noul probability ≥ 0.6, confidence: min(choice/score/noul confidences)}`.
- `FakeEvaluator` gains a deterministic version (all skills "new", weight 3, required false) so tests/dev need no key.

Frontend debounces the skills field ~600 ms, POSTs filled fields + parsed skills + existing criteria, appends rows for `new` suggestions; a `Set` of already-suggested skills prevents repeat rows.

## 6. Candidate pipeline upgrades

- Candidate row gains `name`, `email`, `mimeType`, `pageCount`, `decision`, `uploadedAt`. `name`/`email`/`pageCount` are filled during extraction (email regex reuse; name = first non-empty line heuristic bounded to 60 chars, else filename-stem title-case like the frontend's `nameFromFile`).
- `evaluations`: `evidence_span_id` → `evidence_span_ids` JSON array (evaluator may cite several spans); `rationale` stays null for now (Jev returns no prose); `reviewed_by`/`reviewed_at` set on manual override from the session username (or `"local"` when auth is off).
- Preview: `GET …/preview` returns stored PDF or normalized preview; `file.url` exposes it.
- Upload accept narrows to `.pdf,.docx` (frontend dropzones updated); images only in listing import.
- `decision` PATCH validates enum and persists; excluded from scoring.

## 7. Persistence

New schema (fresh installs) + additive migration for the existing demo DB via `PRAGMA table_info` checks:

- `jobs` → `openings`: `+department, location, description, employment_type, work_arrangement, experience_level, education_level, skills_json, closes_at, source_type, source_url, source_filename, status, created_at, updated_at` (`ALTER TABLE jobs RENAME TO openings` when the old name exists).
- `criteria`: `+required, suggested_weight, suggestion_confidence`
- `candidates`: `+name, email, mime_type, page_count, decision, uploaded_at`
- `evaluations`: `evidence_span_id` → `evidence_span_ids` (TEXT JSON), `+rationale, reviewed_by, reviewed_at`

## 8. Frontend changes

- `lib/api.ts` (new): `apiFetch` (same-origin cookies, `{detail}` error unwrap like `lib/auth.ts`) + typed calls.
- `lib/openings.tsx`: drop seed; `useOpenings()` backed by `GET /api/openings` with subscribe/refresh; `addOpening`→POST, `updateOpening`→PATCH, `openingFromApi` maps payload + assigns icon by department (existing lucide map).
- `lib/candidates.ts`: `useCandidates(openingId)` = fetch + `EventSource(/api/openings/{id}/events)` applying `snapshot`/`candidate.updated`; `addCandidates`→multipart POST; helpers `setDecision`, `retryCandidate`, `reviewCriterion`.
- `import-opening-form.tsx`: real `POST /api/openings/import/link|file`; keep "Reading the listing…" state; error line on failure (stay on import view).
- `manual-opening-form.tsx`: debounced skills→suggestions merge.
- `add-candidates-dialog.tsx` + `opening-detail.tsx` dropzone: `accept=".pdf,.docx"`.
- `opening-detail.tsx`, `cv-viewer.tsx`, `app-layout.tsx`, `pages/*`: unchanged — data flows via stores; `file.url` is now real.

## 9. Config & ops

`.env.example` + `docker-compose.yml` env passthrough gain:

```
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL=openai/gpt-6-luna
TAVILY_API_KEY=
SMARTCV_FAKE_IMPORTER=false
```

README gains an "import a listing" paragraph (keys needed; fake importer for offline demos) and the updated route names.

## 10. Testing

- `test_openings_api.py` — CRUD, field round-trip, counts, validation errors, auth gate.
- `test_import.py` — link happy path (FakeImporter), file import, 503 unconfigured, 422 empty result; agent unit tests with `httpx.MockTransport`: HTML strip, thin→Tavily edge, JSON-schema parse, Jev-weight merge, provider-failure paths.
- `test_criteria_suggestions.py` — fake-evaluator path, matched vs new, request validation.
- `test_candidates_api.py` — upload/order/statuses, name+email extraction, preview URL, spans w/ bbox, review override sets reviewedBy/At, decision PATCH, retry; rename `test_api.py`/`test_batch_flow.py` job paths → openings.
- Frontend vitest — `suggestion-merge` util + `api` mapping tests; dropzone accept change.

## 11. Out of scope

- Image/OCR CVs (spec holds: PDF/DOCX only).
- Screenshot/PDF-of-CV import path beyond the job-ad uploader.
- Multi-user review workflows, roles, real auth.
- Persisted import drafts (review happens in the dialog before save).
- LLM-generated criterion descriptions during manual entry (Jev returns judgments; description uses a template).

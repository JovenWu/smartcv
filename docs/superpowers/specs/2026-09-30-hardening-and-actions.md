# SmartCV hardening + record actions — shared contract

Coordination document for the parallel workstreams. Every agent MUST match
these interfaces exactly; anything not listed stays as it is today.

## Domain model

- `OpeningStatus` gains `"archived"` → union is `"draft" | "open" | "closed" | "archived"`.
  - Backend: `schemas.py` enum, `database.py` accepts it (TEXT column, no CHECK — no migration needed).
  - Frontend: `types.ts` union.
  - `GET /api/openings` returns ALL openings incl. archived (status field on payload). Frontend filters.
- `Opening` payload keeps all existing fields; `status` is already serialized.

## New/changed backend endpoints

| Method | Path | Body | Response |
|---|---|---|---|
| DELETE | `/api/openings/{oid}` | — | 204; cascades candidates+evaluations+evidence_spans+criteria rows and unlinks stored/preview files; removes pending worker items; publishes `opening.deleted` to SSE subscribers and terminates their streams |
| DELETE | `/api/openings/{oid}/candidates/{cid}` | — | 204; deletes evaluations/evidence_spans/candidate row, unlinks stored+preview files, drops cid from worker pending set, publishes `candidate.deleted` `{candidateId}` then a fresh `opening.progress`; runs terminal check (may emit `opening.complete`/`opening.final`) |
| POST | `/api/openings/{oid}/candidates/bulk-decision` | `{candidateIds: string[], decision: CandidateDecision}` | 200 `{updated: int}`; skips unknown ids; publishes one `candidate.updated` per changed row? NO — publish a single `candidates.updated` `{candidateIds}` event then `opening.progress` |
| PATCH | `/api/openings/{oid}` (existing) | `status` may now be `archived`; `is_final` reset only when `criteria` is present in the patch | unchanged |

SSE event names: `snapshot`, `candidate.updated`, `candidate.deleted`,
`candidates.updated`, `opening.progress`, `opening.complete`, `opening.deleted`.
Heartbeat: `: hb\n\n` comment every ~15 s inside the stream generator.

## Repository API (backend/app/database.py)

```python
async def delete_candidate(self, candidate_id: str) -> tuple[str, ...] | None:
    """Delete evaluations, evidence_spans and the candidate row.
    Returns (stored_path, preview_path, opening_id) or None if missing."""

async def delete_opening(self, opening_id: str) -> list[tuple[str, str]] | None:
    """Delete the opening and all child rows.
    Returns list of (stored_path, preview_path) for file cleanup, or None."""

async def bulk_set_decision(self, opening_id: str, candidate_ids: list[str], decision: str) -> int
```

Worker pool gets `discard_pending(candidate_id)` removing a queued item
(worker.py `_pending` deque/set — check actual structure).

## SQLite hardening (same file)

- `PRAGMA foreign_keys = ON` after connect; `PRAGMA journal_mode = WAL`.
- New idempotent indexes applied in `open()` after `_migrate`:
  `candidates(opening_id)`, `candidates(opening_id, file_hash)`,
  `candidates(opening_id, status)`, `evidence_spans(candidate_id)`,
  `evaluations(candidate_id)`.
- Manual cascade in the delete methods (works for old DBs; no table rebuild).
- Criteria-changing PATCH: drop evaluation rows for removed criterion ids,
  recompute `total_score` from remaining evals, requeue candidates that now
  lack an eval for a current criterion (worker.enqueue), fix `is_final`
  only when the set changed. Non-criteria patches never touch `is_final`.

## EventHub (backend/app/events.py)

- `asyncio.Queue(maxsize=256)` per subscriber; on overflow drop that
  subscriber (publish "close" sentinel) instead of unbounded growth.
- New `close_opening(opening_id)` — publishes `opening.deleted` then closes
  all its subscribers' queues.
- Reduce fan-out: `publish_candidate_update` computes counts once; keep the
  same event names the frontend already handles.

## Frontend data layer (lib/)

`apiFetch` (`lib/api.ts`):
- returns `undefined` on 204/empty body (guarded `json()`);
- on any 401 → clear session + `window.location.assign("/login")`;
- optional `AbortSignal` passthrough.

```ts
openingsApi = {
  list, create, update,          // existing
  remove(id: string): Promise<void>,                       // DELETE
}
candidatesApi = {
  list(openingId),                                        // GET list
  remove(openingId, candidateId): Promise<void>,          // DELETE
  setDecision(openingId, candidateId, decision),          // exists as setDecision
  bulkSetDecision(openingId, ids: string[], decision),    // POST bulk-decision
  retry(openingId, candidateId),                          // exists as retryCandidate
  reviewCriterion(openingId, candidateId, criterionId, {status, note}), // exists
  spans(openingId, candidateId): Promise<EvidenceSpan[]>, // GET spans
}
```

`lib/openings.tsx`: `removeOpening(id)` (DELETE + refresh),
`setOpeningArchived(id, archived: boolean)` (PATCH `{status}` + refresh),
`useOpenings()` still returns every opening — pages/sidebar filter by
`status !== "archived"`. Debounce SSE-triggered `refreshOpenings`
(trailing ~500 ms) so a batch doesn't refetch-per-event.

`lib/candidates.ts`: handle `candidate.deleted` (drop row),
`candidates.updated` (refetch that opening's list once), `opening.deleted`
(close ES, clear entry, emit so page can navigate away). Add
`useCandidatesStatus(openingId): "loading" | "ready" | "error"`; keep the
last list visible while refetching (no empty-dropzone flash); guard
`JSON.parse` in SSE listener.

`hooks/use-session.ts` → single shared store (fetch once, all consumers
share), same public shape `{authenticated, username} | null` while loading.

## UI contract (pages/components)

- App header (`app-layout.tsx`): `border-b bg-background` + keep h-16 —
  visible seam above the scroll region; scroll containers keep `p-4 pt-0`.
- `CvViewerLayout`: keep `ResizablePanelGroup` always mounted; render the
  second panel/handle only when `selected && !isMobile`; mobile keeps the
  `fixed` overlay. `children` must never change tree position.
- Remove `useAutoAnimate` from `<tbody>` (keep on the wrapper div).
- Openings page: per-card dropdown menu (…) → Open / Archive|Unarchive /
  Delete (destructive, confirm dialog). Archived openings hidden by default;
  a filter control (e.g. select or toggle in the card grid header area)
  reveals an "Archived" group/badge. Sidebar `NavOpenings`: `SidebarMenuAction`
  dropdown with Archive/Delete; archived openings never shown in sidebar.
- Opening detail page gets an opening summary header (collapsible or compact
  block): title, meta line, status badge (Archived/Closed/Open), closesAt,
  description, criteria list with weight badges, source link when present.
- Candidate row: decision dropdown (undecided/shortlisted/passed), retry
  button on `retryable` failed rows, row menu → View evidence (spans
  dialog listing excerpts + page numbers + "Open CV" button that opens the
  CvViewer; iframe url may append `#page=N`), Delete (confirm dialog).
- `needs_review`/`MatchCell` cells get a small dialog to set
  not_found/partial/strong + note via `reviewCriterion`.
- Bulk selection: checkbox column on the scorecard + floating action bar
  (Shortlist / Pass / Delete selected) when ≥1 selected.
- Delete confirmation uses existing `ui/dialog` (no new primitive needed).
- Candidate deletion while its CV is open → `closeCv()`.
- Detail page breadcrumb: subscribe `useOpenings()` in AppLayout so the
  crumb resolves after store load.
- Detail page: gate `!opening` on `useOpeningsStatus()==="ready"` (kills the
  "Opening not found" flash), candidates empty state gated on
  `useCandidatesStatus()==="ready"`.

## Security/perf notes to honor

- Importer: `_check_url` must DNS-resolve hostnames (getaddrinfo in a
  thread) and reject non-public resolved IPs; browser tier must intercept
  via `page.route` and abort requests to non-public destinations; cap
  concurrent browser imports with `asyncio.Semaphore(2)`.
- Login: in-memory per-IP sliding window, 10 attempts/60 s → 429.
- Cookie `secure` flag honors `X-Forwarded-Proto`; uvicorn `--proxy-headers`
  already implied — read the header defensively.
- All blocking file I/O in async paths → `asyncio.to_thread`.
- Upload loop: single `add_candidates` commit per batch + unlink stored
  file if the insert raises.
- Snapshot `None` in the SSE route → close stream (404 handled upfront).

## Verification

- Backend: `backend/.venv/Scripts/python -m pytest backend/tests -q`
- Frontend: `npm run build` (tsc), `npm run lint`, `npm run test -- --run`
- Repo style: TypeScript strict, shadcn/ui primitives, monochrome design
  (PRODUCT.md — no new accent colors), no emojis in code.

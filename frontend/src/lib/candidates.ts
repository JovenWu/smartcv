import { useMemo, useSyncExternalStore } from "react"

import { apiFetch } from "@/lib/api"
import { refreshOpenings } from "@/lib/openings"
import type { Candidate, CandidateDecision, CandidateStatus } from "@/types"

/**
 * Per-opening candidate cache fed by GET + SSE. Each opening id keeps its
 * own list and one EventSource; both live as long as at least one hook
 * subscriber is mounted.
 */
interface CacheEntry {
  list: Candidate[]
  refs: number
  loaded: boolean
  events?: EventSource
}

const caches = new Map<string, CacheEntry>()
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

function entryFor(openingId: string): CacheEntry {
  let entry = caches.get(openingId)
  if (!entry) {
    entry = { list: [], refs: 0, loaded: false }
    caches.set(openingId, entry)
  }
  return entry
}

export type CandidateSort = {
  /** "name", "score", or a criterion id. */
  column: string
  dir: "asc" | "desc"
}

export const IN_FLIGHT_STATUSES: ReadonlySet<CandidateStatus> = new Set([
  "queued",
  "extracting",
  "evaluating",
])

function sortValue(
  candidate: Candidate,
  column: string,
): number | string | null {
  if (column === "name") return candidate.name.toLowerCase()
  if (column === "score") return candidate.totalScore
  const evaluation = candidate.evaluations.find(
    (e) => e.criterionId === column,
  )
  if (!evaluation) return null
  return evaluation.manualFraction ?? evaluation.modelFraction
}

export function sortCandidates(
  list: Candidate[],
  sort: CandidateSort,
): Candidate[] {
  // Missing values (unscored, no evaluation) always sink to the bottom,
  // whichever direction. uploadOrder breaks ties so rows never jitter.
  const sign = sort.dir === "asc" ? 1 : -1
  return [...list].sort((a, b) => {
    const av = sortValue(a, sort.column)
    const bv = sortValue(b, sort.column)
    if (av == null && bv == null) return a.uploadOrder - b.uploadOrder
    if (av == null) return 1
    if (bv == null) return -1
    const cmp =
      typeof av === "string"
        ? av.localeCompare(bv as string)
        : av - (bv as number)
    return cmp * sign || a.uploadOrder - b.uploadOrder
  })
}

function rankCandidates(list: Candidate[]): Candidate[] {
  return sortCandidates(list, { column: "score", dir: "desc" })
}

/**
 * Display order for the scorecard: under the default score-desc view,
 * in-flight candidates pin to the top so active work stays visible; they
 * glide into ranked position as scores land. Any user-chosen sort applies
 * literally.
 */
export function orderCandidates(
  list: Candidate[],
  sort: CandidateSort,
): Candidate[] {
  const sorted = sortCandidates(list, sort)
  if (sort.column !== "score" || sort.dir !== "desc") return sorted
  const active = sorted.filter((c) => IN_FLIGHT_STATUSES.has(c.status))
  if (active.length === 0) return sorted
  const rest = sorted.filter((c) => !IN_FLIGHT_STATUSES.has(c.status))
  return [...active, ...rest]
}

function setList(openingId: string, list: Candidate[]) {
  entryFor(openingId).list = rankCandidates(list)
  emit()
}

function upsert(openingId: string, candidate: Candidate) {
  const entry = entryFor(openingId)
  const index = entry.list.findIndex((c) => c.id === candidate.id)
  const list = [...entry.list]
  if (index === -1) list.push(candidate)
  else list[index] = candidate
  entry.list = rankCandidates(list)
  emit()
}

function onEvent(openingId: string, event: string, data: unknown) {
  const payload = data as Record<string, unknown>
  switch (event) {
    case "snapshot":
    case "opening.complete": {
      const candidates = payload.candidates as Candidate[] | undefined
      if (candidates) setList(openingId, candidates)
      void refreshOpenings().catch(() => {})
      // Terminal stream — EventSource would otherwise auto-reconnect and
      // the server would replay the snapshot in a poll loop.
      const opening = payload.opening as { isFinal?: boolean } | undefined
      if (event === "opening.complete" || opening?.isFinal) {
        caches.get(openingId)?.events?.close()
      }
      break
    }
    case "candidate.updated": {
      const candidate = payload.candidate as Candidate | undefined
      if (candidate) upsert(openingId, candidate)
      void refreshOpenings().catch(() => {})
      break
    }
    case "opening.progress":
      void refreshOpenings().catch(() => {})
      break
  }
}

function ensureStream(openingId: string) {
  const entry = entryFor(openingId)
  if (
    typeof EventSource !== "function" ||
    (entry.events && entry.events.readyState !== EventSource.CLOSED)
  ) {
    return
  }
  const events = new EventSource(`/api/openings/${openingId}/events`)
  for (const name of [
    "snapshot",
    "candidate.updated",
    "opening.progress",
    "opening.complete",
  ]) {
    events.addEventListener(name, (e: MessageEvent) => {
      onEvent(openingId, name, JSON.parse(e.data))
    })
  }
  events.onerror = () => {
    // The server closes the stream after opening.complete — that's normal.
  }
  entry.events = events
}

function attach(openingId: string) {
  const entry = entryFor(openingId)
  ensureStream(openingId)
  if (entry.loaded) return
  entry.loaded = true
  void apiFetch<Candidate[]>(`/api/openings/${openingId}/candidates`)
    .then((list) => setList(openingId, list))
    .catch(() => {
      entry.loaded = false
    })
}

function detach(openingId: string) {
  const entry = caches.get(openingId)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs <= 0) {
    entry.events?.close()
    caches.delete(openingId)
  }
}

function subscribe(openingId: string | undefined) {
  return (callback: () => void) => {
    listeners.add(callback)
    if (!openingId) {
      return () => listeners.delete(callback)
    }
    entryFor(openingId).refs += 1
    attach(openingId)
    return () => {
      listeners.delete(callback)
      detach(openingId)
    }
  }
}

const EMPTY: Candidate[] = []

export function useCandidates(openingId: string | undefined): Candidate[] {
  // Stable subscribe fn per opening id — useSyncExternalStore resubscribes
  // when it changes identity.
  const subscribeFor = useMemo(() => subscribe(openingId), [openingId])
  return useSyncExternalStore(subscribeFor, () =>
    openingId ? (caches.get(openingId)?.list ?? EMPTY) : EMPTY,
  )
}

export interface BatchUploadResponse {
  candidates: Candidate[]
  /** Same-bytes files already in this opening — skipped, row unchanged. */
  duplicates: Candidate[]
  totalCount: number
}

export function duplicateNotice(
  result: BatchUploadResponse,
): string | null {
  const names = result.duplicates.map((d) => d.file.filename)
  if (!names.length) return null
  const shown = names.slice(0, 3).join(", ")
  const extra = names.length > 3 ? ` and ${names.length - 3} more` : ""
  return `${names.length} already in this opening, skipped: ${shown}${extra}`
}

export async function addCandidates(
  openingId: string,
  files: File[],
): Promise<BatchUploadResponse> {
  const form = new FormData()
  files.forEach((file) => form.append("files", file))
  const response = await apiFetch<BatchUploadResponse>(
    `/api/openings/${openingId}/candidates`,
    { method: "POST", body: form },
  )
  response.candidates.forEach((candidate) => upsert(openingId, candidate))
  response.duplicates.forEach((candidate) => upsert(openingId, candidate))
  // If a previous batch closed the stream via opening.complete, reopen it
  // so the new uploads stream their updates live.
  ensureStream(openingId)
  await refreshOpenings()
  return response
}

export async function reviewCriterion(
  openingId: string,
  candidateId: string,
  criterionId: string,
  review: { matchLevel: "strong" | "partial" | "not_found"; reviewNote?: string },
): Promise<Candidate> {
  const updated = await apiFetch<Candidate>(
    `/api/openings/${openingId}/candidates/${candidateId}`
      + `/criteria/${criterionId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(review),
    },
  )
  upsert(openingId, updated)
  return updated
}

export async function setDecision(
  openingId: string,
  candidateId: string,
  decision: CandidateDecision,
): Promise<Candidate> {
  const updated = await apiFetch<Candidate>(
    `/api/openings/${openingId}/candidates/${candidateId}/decision`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    },
  )
  upsert(openingId, updated)
  return updated
}

export async function retryCandidate(
  openingId: string,
  candidateId: string,
): Promise<Candidate> {
  const updated = await apiFetch<Candidate>(
    `/api/openings/${openingId}/candidates/${candidateId}/retry`,
    { method: "POST" },
  )
  upsert(openingId, updated)
  ensureStream(openingId)
  return updated
}

/** Test hook — clears caches and closes any open streams. */
export function __resetCandidatesForTests() {
  for (const entry of caches.values()) entry.events?.close()
  caches.clear()
}

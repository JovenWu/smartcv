import { useMemo, useSyncExternalStore } from "react"

import {
  apiFetch,
  candidatesApi,
  type CriterionReview,
} from "@/lib/api"
import { refreshOpenings, refreshOpeningsSoon } from "@/lib/openings"
import type {
  BulkDecisionResult,
  Candidate,
  CandidateDecision,
  CandidateStatus,
} from "@/types"

interface CacheEntry {
  list: Candidate[]
  refs: number
  loaded: boolean
  error: boolean
  deleted: boolean
  fetching: boolean
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
    entry = {
      list: [],
      refs: 0,
      loaded: false,
      error: false,
      deleted: false,
      fetching: false,
    }
    caches.set(openingId, entry)
  }
  return entry
}

export type CandidateSort = {
  /** "name", "score", "decision", or a criterion id. */
  column: string
  dir: "asc" | "desc"
}

export const IN_FLIGHT_STATUSES: ReadonlySet<CandidateStatus> = new Set([
  "queued",
  "extracting",
  "evaluating",
])

const DECISION_RANK: Record<CandidateDecision, number> = {
  passed: 0,
  undecided: 1,
  shortlisted: 2,
}

function sortValue(
  candidate: Candidate,
  column: string,
): number | string | null {
  if (column === "name") return candidate.name.toLowerCase()
  if (column === "score") return candidate.totalScore
  if (column === "decision") return DECISION_RANK[candidate.decision] ?? null
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

function fetchList(openingId: string) {
  const entry = entryFor(openingId)
  if (entry.fetching || entry.deleted) return
  entry.fetching = true
  void candidatesApi
    .list(openingId)
    .then((list) => {
      if (entry.deleted) return
      entry.loaded = true
      entry.error = false
      setList(openingId, list)
    })
    .catch(() => {
      entry.loaded = false
      entry.error = true
      emit()
    })
    .finally(() => {
      entry.fetching = false
    })
}

function onEvent(openingId: string, event: string, data: unknown) {
  const payload = data as Record<string, unknown>
  switch (event) {
    case "snapshot":
    case "opening.complete": {
      const candidates = payload.candidates as Candidate[] | undefined
      if (candidates) setList(openingId, candidates)
      refreshOpeningsSoon()
      const opening = payload.opening as { isFinal?: boolean } | undefined
      if (event === "opening.complete" || opening?.isFinal) {
        caches.get(openingId)?.events?.close()
      }
      break
    }
    case "candidate.updated": {
      const candidate = payload.candidate as Candidate | undefined
      if (candidate) upsert(openingId, candidate)
      refreshOpeningsSoon()
      break
    }
    case "candidate.deleted": {
      const candidateId = payload.candidateId as string | undefined
      if (candidateId) {
        const entry = entryFor(openingId)
        entry.list = entry.list.filter((c) => c.id !== candidateId)
        emit()
      }
      refreshOpeningsSoon()
      break
    }
    case "candidates.updated":
      fetchList(openingId)
      break
    case "opening.deleted": {
      const entry = caches.get(openingId)
      if (entry) {
        entry.events?.close()
        entry.events = undefined
        entry.list = []
        entry.deleted = true
        emit()
      }
      refreshOpeningsSoon()
      break
    }
    case "opening.progress":
      refreshOpeningsSoon()
      break
  }
}

function ensureStream(openingId: string) {
  const entry = entryFor(openingId)
  if (
    entry.deleted ||
    typeof EventSource !== "function" ||
    (entry.events && entry.events.readyState !== EventSource.CLOSED)
  ) {
    return
  }
  const events = new EventSource(`/api/openings/${openingId}/events`)
  for (const name of [
    "snapshot",
    "candidate.updated",
    "candidate.deleted",
    "candidates.updated",
    "opening.progress",
    "opening.complete",
    "opening.deleted",
  ]) {
    events.addEventListener(name, (e: MessageEvent) => {
      try {
        onEvent(openingId, name, JSON.parse(e.data))
      } catch {
      }
    })
  }
  events.onerror = () => {
  }
  entry.events = events
}

function attach(openingId: string) {
  const entry = entryFor(openingId)
  if (entry.deleted) return
  ensureStream(openingId)
  if (!entry.loaded) fetchList(openingId)
}

function detach(openingId: string) {
  const entry = caches.get(openingId)
  if (!entry) return
  entry.refs -= 1
  if (entry.refs <= 0) {
    entry.refs = 0
    entry.events?.close()
    entry.events = undefined
    entry.loaded = false
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
  const subscribeFor = useMemo(() => subscribe(openingId), [openingId])
  return useSyncExternalStore(subscribeFor, () =>
    openingId ? (caches.get(openingId)?.list ?? EMPTY) : EMPTY,
  )
}

export type CandidatesStatus = "loading" | "ready" | "error"

/**
 * Load state of the per-opening candidate list: "loading" until the first
 * GET resolves, "error" when it failed or the opening was deleted
 * (subscribers can react — e.g. navigate away — via this or the openings
 * store, which drops the opening on the next refresh).
 */
export function useCandidatesStatus(
  openingId: string | undefined,
): CandidatesStatus {
  const subscribeFor = useMemo(() => subscribe(openingId), [openingId])
  return useSyncExternalStore(subscribeFor, () => {
    const entry = openingId ? caches.get(openingId) : undefined
    if (!entry) return "loading"
    if (entry.error || entry.deleted) return "error"
    return entry.loaded ? "ready" : "loading"
  })
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
  ensureStream(openingId)
  await refreshOpenings()
  return response
}

export async function reviewCriterion(
  openingId: string,
  candidateId: string,
  criterionId: string,
  review: CriterionReview,
): Promise<Candidate> {
  const updated = await candidatesApi.reviewCriterion(
    openingId,
    candidateId,
    criterionId,
    review,
  )
  upsert(openingId, updated)
  return updated
}

export async function setDecision(
  openingId: string,
  candidateId: string,
  decision: CandidateDecision,
): Promise<Candidate> {
  const updated = await candidatesApi.setDecision(
    openingId,
    candidateId,
    decision,
  )
  upsert(openingId, updated)
  return updated
}

export async function bulkSetDecision(
  openingId: string,
  candidateIds: string[],
  decision: CandidateDecision,
): Promise<BulkDecisionResult> {
  const result = await candidatesApi.bulkSetDecision(
    openingId,
    candidateIds,
    decision,
  )
  fetchList(openingId)
  return result
}

export async function removeCandidate(
  openingId: string,
  candidateId: string,
): Promise<void> {
  await candidatesApi.remove(openingId, candidateId)
  const entry = caches.get(openingId)
  if (entry) {
    entry.list = entry.list.filter((c) => c.id !== candidateId)
    emit()
  }
  refreshOpeningsSoon()
}

export async function retryCandidate(
  openingId: string,
  candidateId: string,
): Promise<Candidate> {
  const updated = await candidatesApi.retry(openingId, candidateId)
  upsert(openingId, updated)
  ensureStream(openingId)
  return updated
}

export function __resetCandidatesForTests() {
  for (const entry of caches.values()) entry.events?.close()
  caches.clear()
}

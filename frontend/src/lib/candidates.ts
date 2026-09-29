import { useMemo, useSyncExternalStore } from "react"

import { apiFetch } from "@/lib/api"
import { refreshOpenings } from "@/lib/openings"
import type { Candidate, CandidateDecision } from "@/types"

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

function setList(openingId: string, list: Candidate[]) {
  entryFor(openingId).list = [...list].sort(
    (a, b) => a.uploadOrder - b.uploadOrder,
  )
  emit()
}

function upsert(openingId: string, candidate: Candidate) {
  const entry = entryFor(openingId)
  const index = entry.list.findIndex((c) => c.id === candidate.id)
  const list = [...entry.list]
  if (index === -1) list.push(candidate)
  else list[index] = candidate
  entry.list = list.sort((a, b) => a.uploadOrder - b.uploadOrder)
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

function attach(openingId: string) {
  const entry = entryFor(openingId)
  if (entry.loaded) return
  entry.loaded = true
  void apiFetch<Candidate[]>(`/api/openings/${openingId}/candidates`)
    .then((list) => setList(openingId, list))
    .catch(() => {
      entry.loaded = false
    })
  if (typeof EventSource !== "function") return
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

interface BatchUploadResponse {
  candidates: Candidate[]
  totalCount: number
}

export async function addCandidates(
  openingId: string,
  files: File[],
): Promise<void> {
  const form = new FormData()
  files.forEach((file) => form.append("files", file))
  const response = await apiFetch<BatchUploadResponse>(
    `/api/openings/${openingId}/candidates`,
    { method: "POST", body: form },
  )
  response.candidates.forEach((candidate) => upsert(openingId, candidate))
  await refreshOpenings()
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
  return updated
}

/** Test hook — clears caches and closes any open streams. */
export function __resetCandidatesForTests() {
  for (const entry of caches.values()) entry.events?.close()
  caches.clear()
}

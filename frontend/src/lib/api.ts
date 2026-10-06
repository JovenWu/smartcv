import { clearSession } from "@/lib/auth"
import type {
  BulkDecisionResult,
  Candidate,
  CandidateDecision,
  EvidenceSpan,
  Opening,
  OpeningSource,
  OpeningStatus,
} from "@/types"

async function parseError(response: Response): Promise<Error> {
  let detail = `Request failed (${response.status})`
  try {
    const body = (await response.json()) as { detail?: unknown }
    if (typeof body.detail === "string") detail = body.detail
  } catch {
  }
  return new Error(detail)
}

/**
 * `init` flows straight to fetch — pass `{ signal }` to abort. Resolves
 * `undefined` for 204/empty-body endpoints; on 401 the session is dropped
 * and the app redirects to /login (unless already there), then throws so
 * the caller still aborts its own flow.
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, init)
  if (
    response.status === 401 &&
    typeof window !== "undefined" &&
    window.location.pathname !== "/login"
  ) {
    clearSession()
    window.location.assign("/login")
  }
  if (!response.ok) throw await parseError(response)
  if (
    response.status === 204 ||
    response.headers.get("content-length") === "0"
  ) {
    return undefined as T
  }
  try {
    return (await response.json()) as T
  } catch (err) {
    if (err instanceof SyntaxError) return undefined as T
    throw err
  }
}

function jsonPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

export interface NewCriterionPayload {
  id: string
  name: string
  description: string
  weight: number
  required?: boolean
  suggestedWeight?: number
  suggestionConfidence?: number
}

export interface NewOpeningPayload {
  title: string
  department?: string
  location?: string
  description?: string
  employmentType?: string
  workArrangement?: string
  experienceLevel?: string
  educationLevel?: string
  skills?: string[]
  closesAt?: string
  source?: OpeningSource
  criteria?: NewCriterionPayload[]
  status?: OpeningStatus
}

export interface ImportCriterion {
  name: string
  description?: string
  required?: boolean
  weight?: number
  suggestedWeight?: number
  suggestionConfidence?: number
}

export interface ImportDraft {
  title: string
  department: string
  location: string
  description: string
  employmentType?: string
  workArrangement?: string
  experienceLevel?: string
  educationLevel?: string
  skills: string[]
  closesAt?: string
  criteria: ImportCriterion[]
  source: OpeningSource
  warnings: string[]
}

export interface CriteriaSuggestionRequest {
  title?: string
  department?: string
  location?: string
  employmentType?: string
  workArrangement?: string
  experienceLevel?: string
  educationLevel?: string
  description?: string
  skills: string[]
  existingCriteria: { id: string; name: string }[]
}

export interface SuggestedCriterion {
  name: string
  description: string
  suggestedWeight: number
  required: boolean
  confidence: number
}

export interface SkillSuggestion {
  skill: string
  matchedCriterionId?: string | null
  criterion?: SuggestedCriterion | null
}

export interface CriteriaSuggestionResponse {
  suggestions: SkillSuggestion[]
}

export const openingsApi = {
  list: () => apiFetch<Opening[]>("/api/openings"),
  create: (input: NewOpeningPayload) =>
    jsonPost<Opening>("/api/openings", input),
  update: (id: string, input: Partial<NewOpeningPayload>) =>
    apiFetch<Opening>(`/api/openings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  remove: (id: string) =>
    apiFetch<void>(`/api/openings/${id}`, { method: "DELETE" }),
  importLink: (url: string) =>
    jsonPost<ImportDraft>("/api/openings/import/link", { url }),
  importFile: (file: File) => {
    const form = new FormData()
    form.append("file", file)
    return apiFetch<ImportDraft>("/api/openings/import/file", {
      method: "POST",
      body: form,
    })
  },
  suggestCriteria: (request: CriteriaSuggestionRequest) =>
    jsonPost<CriteriaSuggestionResponse>(
      "/api/criteria-suggestions",
      request,
    ),
}

export interface CriterionReview {
  matchLevel: "strong" | "partial" | "not_found"
  reviewNote?: string
}

export interface UserInfo {
  id: string
  username: string
  isAdmin: boolean
  isActive: boolean
  createdAt: string
}

export const usersApi = {
  list: () => apiFetch<UserInfo[]>("/api/admin/users"),
  create: (input: {
    username: string
    password: string
    isAdmin?: boolean
  }) => jsonPost<UserInfo>("/api/admin/users", input),
  update: (id: string, input: { isActive?: boolean; isAdmin?: boolean }) =>
    apiFetch<UserInfo>(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  resetPassword: (id: string, password: string) =>
    jsonPost<void>(`/api/admin/users/${id}/reset-password`, { password }),
}

export const candidatesApi = {
  list: (openingId: string) =>
    apiFetch<Candidate[]>(`/api/openings/${openingId}/candidates`),
  remove: (openingId: string, candidateId: string) =>
    apiFetch<void>(
      `/api/openings/${openingId}/candidates/${candidateId}`,
      { method: "DELETE" },
    ),
  setDecision: (
    openingId: string,
    candidateId: string,
    decision: CandidateDecision,
  ) =>
    apiFetch<Candidate>(
      `/api/openings/${openingId}/candidates/${candidateId}/decision`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      },
    ),
  bulkSetDecision: (
    openingId: string,
    candidateIds: string[],
    decision: CandidateDecision,
  ) =>
    jsonPost<BulkDecisionResult>(
      `/api/openings/${openingId}/candidates/bulk-decision`,
      { candidateIds, decision },
    ),
  retry: (openingId: string, candidateId: string) =>
    apiFetch<Candidate>(
      `/api/openings/${openingId}/candidates/${candidateId}/retry`,
      { method: "POST" },
    ),
  reviewCriterion: (
    openingId: string,
    candidateId: string,
    criterionId: string,
    review: CriterionReview,
  ) =>
    apiFetch<Candidate>(
      `/api/openings/${openingId}/candidates/${candidateId}`
        + `/criteria/${criterionId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(review),
      },
    ),
  spans: (openingId: string, candidateId: string) =>
    apiFetch<EvidenceSpan[]>(
      `/api/openings/${openingId}/candidates/${candidateId}/spans`,
    ),
}

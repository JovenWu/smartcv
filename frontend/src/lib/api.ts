import type { Opening, OpeningSource } from "@/types"

/**
 * Thin fetch wrapper — unwraps FastAPI `{detail}` error bodies and returns
 * parsed JSON. Mirrors lib/auth.ts so callers see the same error style.
 */
async function parseError(response: Response): Promise<Error> {
  let detail = `Request failed (${response.status})`
  try {
    const body = (await response.json()) as { detail?: unknown }
    if (typeof body.detail === "string") detail = body.detail
  } catch {
    // Non-JSON body — keep the status-based message.
  }
  return new Error(detail)
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) throw await parseError(response)
  return (await response.json()) as T
}

function jsonPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

// ---------- API payloads ----------

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
}

export interface ImportCriterion {
  name: string
  description?: string
  required?: boolean
  weight?: number
  suggestedWeight?: number
  suggestionConfidence?: number
}

/** Reviewer-editable extraction result; persisted only on form submit. */
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
  update: (id: string, input: NewOpeningPayload) =>
    apiFetch<Opening>(`/api/openings/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
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

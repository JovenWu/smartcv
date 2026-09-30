/**
 * SmartCV domain model — the contract the backend conforms to.
 * Derived values (scores, counts, provisional flags) are computed
 * server-side; the UI never mutates them directly.
 */

// ---------- Openings ----------

export type OpeningStatus = "draft" | "open" | "closed" | "archived"

export type EmploymentType =
  | "full_time"
  | "part_time"
  | "contract"
  | "internship"
  | "casual"

export type WorkArrangement = "remote" | "hybrid" | "onsite"

export interface OpeningSource {
  type: "manual" | "link" | "file"
  /** Listing URL when type is "link". */
  url?: string
  /** Original filename when type is "file". */
  filename?: string
}

export interface Opening {
  id: string
  title: string
  department: string
  location: string
  /** Full ad text / role context the screener reads. */
  description: string
  employmentType?: EmploymentType
  workArrangement?: WorkArrangement
  /** Free text like "3+ years" or "Fresh graduate". */
  experienceLevel?: string
  /** Free text like "Bachelor's degree". */
  educationLevel?: string
  /** Flat skill tags — can seed suggested criteria later. */
  skills?: string[]
  /** Applications close after this date (job board validThrough). */
  closesAt?: string
  source: OpeningSource
  status: OpeningStatus
  criteria: Criterion[]
  createdAt: string
  updatedAt?: string

  // Computed on the backend; present here so the UI sketch runs standalone.
  candidates: number
  pendingReview: number
}

// ---------- Criteria (the rubric per opening) ----------

export interface Criterion {
  id: string
  name: string
  /** What evidence to look for in the CV. */
  description: string
  /** Recruiter-confirmed weight, 1–5. */
  weight: number
  /** Knockout: a failed must-have overrides the weighted total. */
  required?: boolean
  /** AI-proposed weight before recruiter confirmation. */
  suggestedWeight?: number
  suggestionConfidence?: number
}

// ---------- Candidates (one per uploaded CV) ----------

export type CandidateStatus =
  | "queued"
  | "extracting"
  | "evaluating"
  | "complete"
  | "needs_review"
  | "failed"

/** The recruiter's call — the tool never auto-rejects. */
export type CandidateDecision = "undecided" | "shortlisted" | "passed"

/** Response of POST /api/openings/{id}/candidates/bulk-decision. */
export interface BulkDecisionResult {
  updated: number
}

export interface CandidateFile {
  filename: string
  /** Preview URL for the source document. */
  url: string
  mimeType: string
  /** Unknown until the document is parsed. */
  pageCount?: number
}

export interface Candidate {
  id: string
  openingId: string
  /** Parsed from the CV; falls back to filename. */
  name: string
  email?: string
  file: CandidateFile
  status: CandidateStatus
  uploadOrder: number
  uploadedAt: string
  evaluations: CriterionEvaluation[]
  /** Weighted total; null until the pass finishes. */
  totalScore: number | null
  /** Rank is provisional until every cell is out of needs_review. */
  isFinal: boolean
  decision: CandidateDecision
  errorMessage?: string
  retryable: boolean
}

// ---------- Evaluations (scorecard cells) ----------

export type MatchStatus =
  | "strong"
  | "partial"
  | "not_found"
  | "needs_review"
  | "reviewed"

export interface CriterionEvaluation {
  criterionId: string
  status: MatchStatus
  /** Model confidence, 0–1. Low values stay visible, never hidden. */
  confidence: number
  /** Model's match fraction, 0–1. Preserved for audit after overrides. */
  modelFraction: number
  /** Several excerpts may justify one criterion. */
  evidenceSpanIds: string[]
  /** One-line model rationale. */
  rationale?: string
  /** Recruiter override — takes precedence over modelFraction. */
  manualFraction?: number
  reviewNote?: string
  reviewedBy?: string
  reviewedAt?: string
}

// ---------- Evidence ----------

export interface EvidenceSpan {
  id: string
  /** 1-based page in the source document. */
  pageNumber: number
  /** Verbatim excerpt. */
  text: string
  /** PDF region for highlight-on-hover, if extraction provides it. */
  bbox?: { x: number; y: number; width: number; height: number }
}

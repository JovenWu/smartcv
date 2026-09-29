export type MatchStatus =
  | "strong"
  | "partial"
  | "not_found"
  | "needs_review"
  | "reviewed";

export type CandidateStatus =
  | "queued"
  | "extracting"
  | "evaluating"
  | "complete"
  | "needs_review"
  | "failed";

export type ReviewMatchLevel = "not_found" | "partial" | "strong";

export interface CriterionInput {
  id: string;
  name: string;
  description: string;
}

export interface Criterion extends CriterionInput {
  weight: number;
}

export interface WeightSuggestion {
  criterion_id: string;
  proposed_weight: number;
  confidence: number;
}

export interface WeightSuggestionResponse {
  suggestions: WeightSuggestion[];
}

export interface EvidenceSpan {
  id: string;
  page_number: number;
  text: string;
}

export interface CriterionEvaluation {
  criterion_id: string;
  status: MatchStatus;
  confidence: number;
  model_fraction: number;
  evidence_span_id: string | null;
  manual_fraction: number | null;
  review_note: string | null;
}

export interface CandidateResult {
  id: string;
  filename: string;
  upload_order: number;
  status: CandidateStatus;
  evaluations: CriterionEvaluation[];
  total_score: number | null;
  error_message: string | null;
  retryable: boolean;
}

export interface JobSnapshot {
  id: string;
  title: string;
  criteria: Criterion[];
  candidates: CandidateResult[];
  completed_count: number;
  total_count: number;
  is_final: boolean;
}

export interface BatchUploadResponse {
  candidates: CandidateResult[];
  total_count: number;
}

export const MAX_BATCH_FILES = 200;
export const MAX_FILE_BYTES = 10_000_000;
export const ACCEPTED_EXTENSIONS = [".pdf", ".docx"] as const;

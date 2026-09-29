import type {
  BatchUploadResponse,
  CandidateResult,
  Criterion,
  CriterionInput,
  EvidenceSpan,
  JobSnapshot,
  ReviewMatchLevel,
  WeightSuggestionResponse,
} from "@/types";

async function parseError(response: Response): Promise<Error> {
  let detail = `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") detail = body.detail;
  } catch {
    // Non-JSON error body — keep the status-based message.
  }
  return new Error(detail);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function suggestWeights(
  criteria: CriterionInput[],
): Promise<WeightSuggestionResponse> {
  return request<WeightSuggestionResponse>(
    "/api/weight-suggestions",
    jsonInit("POST", { criteria }),
  );
}

export function createJob(
  title: string,
  criteria: Criterion[],
): Promise<JobSnapshot> {
  return request<JobSnapshot>(
    "/api/jobs",
    jsonInit("POST", { title, criteria }),
  );
}

export async function uploadCvs(
  jobId: string,
  files: File[],
): Promise<BatchUploadResponse> {
  const form = new FormData();
  for (const file of files) form.append("files", file);

  const response = await fetch(`/api/jobs/${jobId}/cvs`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as BatchUploadResponse;
}

export function getJob(jobId: string): Promise<JobSnapshot> {
  return request<JobSnapshot>(`/api/jobs/${jobId}`);
}

export function getSpans(
  jobId: string,
  candidateId: string,
): Promise<EvidenceSpan[]> {
  return request<EvidenceSpan[]>(
    `/api/jobs/${jobId}/candidates/${candidateId}/spans`,
  );
}

export function reviewCriterion(
  jobId: string,
  candidateId: string,
  criterionId: string,
  matchLevel: ReviewMatchLevel,
  reviewNote: string | null,
): Promise<CandidateResult> {
  return request<CandidateResult>(
    `/api/jobs/${jobId}/candidates/${candidateId}/criteria/${criterionId}`,
    jsonInit("PATCH", { match_level: matchLevel, review_note: reviewNote }),
  );
}

export function retryCandidate(
  jobId: string,
  candidateId: string,
): Promise<CandidateResult> {
  return request<CandidateResult>(
    `/api/jobs/${jobId}/candidates/${candidateId}/retry`,
    { method: "POST" },
  );
}

export function previewUrl(jobId: string, candidateId: string): string {
  return `/api/jobs/${jobId}/candidates/${candidateId}/preview`;
}

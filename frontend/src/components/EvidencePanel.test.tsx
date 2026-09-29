import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CandidateResult,
  CriterionEvaluation,
  JobSnapshot,
} from "@/types";
import { EvidencePanel } from "./EvidencePanel";

const criteria = [
  { id: "c-python", name: "Python", description: "", weight: 4 },
  { id: "c-sql", name: "SQL", description: "", weight: 2 },
];

function makeJob(candidates: CandidateResult[]): JobSnapshot {
  return {
    id: "job-1",
    title: "Backend Engineer",
    criteria,
    candidates,
    completed_count: candidates.length,
    total_count: candidates.length,
    is_final: true,
  };
}

function evalFor(
  criterionId: string,
  patch: Partial<CriterionEvaluation> = {},
): CriterionEvaluation {
  return {
    criterion_id: criterionId,
    status: "strong",
    confidence: 0.93,
    model_fraction: 1,
    evidence_span_id: "s1",
    manual_fraction: null,
    review_note: null,
    ...patch,
  };
}

function makeCandidate(
  patch: Partial<CandidateResult> = {},
): CandidateResult {
  return {
    id: "cand-1",
    filename: "alice.pdf",
    upload_order: 0,
    status: "complete",
    evaluations: [
      evalFor("c-python"),
      evalFor("c-sql", {
        status: "partial",
        model_fraction: 0.5,
        evidence_span_id: null,
      }),
    ],
    total_score: 88.5,
    error_message: null,
    retryable: false,
    ...patch,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setupFetch({
  spans = [
    { id: "s1", page_number: 2, text: "Led Python services for 5 years" },
  ],
  previewOk = true,
}: { spans?: unknown[]; previewOk?: boolean } = {}) {
  const fetchMock = vi.mocked(fetch);
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/spans")) return jsonResponse(spans);
    if (url.endsWith("/preview")) {
      return previewOk
        ? new Response(new Uint8Array([1]), { status: 200 })
        : jsonResponse({ detail: "No preview available" }, 404);
    }
    if (url.includes("/criteria/")) {
      return jsonResponse(makeCandidate(), 200);
    }
    if (url.endsWith("/retry")) return jsonResponse(makeCandidate(), 200);
    throw new Error(`Unexpected fetch ${url} ${init?.method}`);
  });
  return fetchMock;
}

describe("EvidencePanel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders criterion rows with confidence and verified evidence", async () => {
    setupFetch();
    const job = makeJob([makeCandidate()]);
    render(
      <EvidencePanel
        job={job}
        candidate={job.candidates[0]}
        onCandidateUpdated={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(/Led Python services for 5 years/),
    ).toBeInTheDocument();
    expect(screen.getByText(/page 2/i)).toBeInTheDocument();
    expect(screen.getAllByText(/93%/)).not.toHaveLength(0);
    expect(screen.getByText("Python")).toBeInTheDocument();
    expect(screen.getByText("SQL")).toBeInTheDocument();
  });

  it("treats not_found as absence of evidence, not disqualification", async () => {
    setupFetch();
    const candidate = makeCandidate({
      evaluations: [
        evalFor("c-python", {
          status: "not_found",
          model_fraction: 0,
          evidence_span_id: null,
        }),
      ],
    });
    const job = makeJob([candidate]);
    render(
      <EvidencePanel
        job={job}
        candidate={candidate}
        onCandidateUpdated={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(/no matching excerpt/i),
    ).toBeInTheDocument();
  });

  it("never renders an excerpt for an unresolved span reference", async () => {
    setupFetch({ spans: [] });
    const job = makeJob([makeCandidate()]);
    render(
      <EvidencePanel
        job={job}
        candidate={job.candidates[0]}
        onCandidateUpdated={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/spans"),
        undefined,
      ),
    );
    expect(
      screen.queryByText(/Led Python services/),
    ).not.toBeInTheDocument();
  });

  it("sends a manual override and reports the updated candidate", async () => {
    const user = userEvent.setup();
    const fetchMock = setupFetch();
    const onUpdated = vi.fn();
    const candidate = makeCandidate();
    render(
      <EvidencePanel
        job={makeJob([candidate])}
        candidate={candidate}
        onCandidateUpdated={onUpdated}
      />,
    );
    await screen.findByText(/Led Python services for 5 years/);

    await user.click(
      screen.getAllByRole("button", { name: /^partial$/i })[0],
    );
    await user.type(
      screen.getAllByLabelText(/review note/i)[0],
      "Verified on page 2",
    );
    await user.click(
      screen.getAllByRole("button", { name: /save review/i })[0],
    );

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    const patchCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/criteria/"),
    );
    expect(patchCall?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(patchCall?.[1]?.body as string)).toEqual({
      match_level: "partial",
      review_note: "Verified on page 2",
    });
  });

  it("offers retry only for retryable failures", async () => {
    setupFetch();
    const retryable = makeCandidate({
      status: "failed",
      error_message: "Evaluator unavailable",
      evaluations: [],
      retryable: true,
      total_score: null,
    });
    const { rerender } = render(
      <EvidencePanel
        job={makeJob([retryable])}
        candidate={retryable}
        onCandidateUpdated={vi.fn()}
      />,
    );
    const retry = await screen.findByRole("button", { name: /retry/i });
    await userEvent.setup().click(retry);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/retry"),
        expect.objectContaining({ method: "POST" }),
      ),
    );

    const permanent = makeCandidate({
      status: "failed",
      error_message: "Not a PDF",
      evaluations: [],
      retryable: false,
      total_score: null,
    });
    rerender(
      <EvidencePanel
        job={makeJob([permanent])}
        candidate={permanent}
        onCandidateUpdated={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /retry/i }),
    ).not.toBeInTheDocument();
  });

  it("flags low-confidence and needs-review evaluations", async () => {
    setupFetch();
    const candidate = makeCandidate({
      status: "needs_review",
      evaluations: [
        evalFor("c-python", { status: "needs_review", confidence: 0.3 }),
      ],
    });
    render(
      <EvidencePanel
        job={makeJob([candidate])}
        candidate={candidate}
        onCandidateUpdated={vi.fn()}
      />,
    );
    expect(await screen.findByText(/low confidence/i)).toBeInTheDocument();
  });

  it("shows an empty-state hint when nothing is selected", () => {
    render(
      <EvidencePanel
        job={makeJob([])}
        candidate={null}
        onCandidateUpdated={vi.fn()}
      />,
    );
    expect(screen.getByText(/select a candidate/i)).toBeInTheDocument();
  });

  it("embeds the normalized preview when available", async () => {
    setupFetch();
    const job = makeJob([makeCandidate()]);
    render(
      <EvidencePanel
        job={job}
        candidate={job.candidates[0]}
        onCandidateUpdated={vi.fn()}
      />,
    );
    const frame = await screen.findByTitle(/cv preview/i);
    expect(frame).toHaveAttribute(
      "src",
      expect.stringContaining("/api/jobs/job-1/candidates/cand-1/preview"),
    );
  });

  it("states plainly when no preview exists", async () => {
    setupFetch({ previewOk: false });
    const job = makeJob([makeCandidate()]);
    render(
      <EvidencePanel
        job={job}
        candidate={job.candidates[0]}
        onCandidateUpdated={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(/no preview available/i),
    ).toBeInTheDocument();
    expect(screen.queryByTitle(/cv preview/i)).not.toBeInTheDocument();
  });
});

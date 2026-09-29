import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  CandidateResult,
  CandidateStatus,
  JobSnapshot,
  MatchStatus,
} from "@/types";
import { Scorecard } from "./Scorecard";

function evaluation(
  criterionId: string,
  status: MatchStatus,
  fraction: number,
): CandidateResult["evaluations"][number] {
  return {
    criterion_id: criterionId,
    status,
    confidence: 0.9,
    model_fraction: fraction,
    evidence_span_id: null,
    manual_fraction: null,
    review_note: null,
  };
}

function candidate(
  id: string,
  filename: string,
  status: CandidateStatus,
  order: number,
  score: number | null = null,
  evaluations: CandidateResult["evaluations"] = [],
  error: string | null = null,
  retryable = false,
): CandidateResult {
  return {
    id,
    filename,
    upload_order: order,
    status,
    evaluations,
    total_score: score,
    error_message: error,
    retryable,
  };
}

const criteria = [
  { id: "c-python", name: "Python", description: "", weight: 4 },
  { id: "c-sql", name: "SQL", description: "", weight: 2 },
];

function makeJob(
  candidates: CandidateResult[],
  isFinal = false,
): JobSnapshot {
  return {
    id: "job-1",
    title: "Backend Engineer",
    criteria,
    candidates,
    completed_count: candidates.filter((c) =>
      ["complete", "needs_review", "failed"].includes(c.status),
    ).length,
    total_count: candidates.length,
    is_final: isFinal,
  };
}

describe("Scorecard", () => {
  it("labels the ranking provisional until the job is final", () => {
    const { rerender } = render(
      <Scorecard
        job={makeJob([candidate("a", "a.pdf", "complete", 0, 80)])}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/provisional/i)).toBeInTheDocument();

    rerender(
      <Scorecard
        job={makeJob([candidate("a", "a.pdf", "complete", 0, 80)], true)}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/final ranking/i)).toBeInTheDocument();
  });

  it("ranks scored candidates descending and leaves others unranked", () => {
    const job = makeJob([
      candidate("low", "low.pdf", "complete", 0, 40),
      candidate("broken", "broken.pdf", "failed", 1, null, [], "corrupt"),
      candidate("high", "high.pdf", "complete", 2, 91),
      candidate("review", "scan.pdf", "needs_review", 3),
    ]);
    render(
      <Scorecard job={job} selectedId={null} onSelect={vi.fn()} />,
    );

    const rows = screen.getAllByRole("row").slice(1); // skip header
    expect(within(rows[0]).getByText("high.pdf")).toBeInTheDocument();
    expect(within(rows[0]).getByText("#1")).toBeInTheDocument();
    expect(within(rows[1]).getByText("low.pdf")).toBeInTheDocument();
    expect(within(rows[1]).getByText("#2")).toBeInTheDocument();
    // Failed and needs-review rows stay visible but carry no fabricated rank.
    expect(within(rows[2]).getByText("broken.pdf")).toBeInTheDocument();
    expect(within(rows[3]).getByText("scan.pdf")).toBeInTheDocument();
    expect(
      within(rows[3]).queryByText(/^#\d+$/),
    ).not.toBeInTheDocument();
  });

  it("re-sorts rows as updated scores arrive", () => {
    const first = makeJob([
      candidate("a", "a.pdf", "complete", 0, 90),
      candidate("b", "b.pdf", "evaluating", 1),
    ]);
    const { rerender } = render(
      <Scorecard job={first} selectedId={null} onSelect={vi.fn()} />,
    );

    const second = makeJob([
      candidate("a", "a.pdf", "complete", 0, 90),
      candidate("b", "b.pdf", "complete", 1, 95),
    ]);
    rerender(
      <Scorecard job={second} selectedId={null} onSelect={vi.fn()} />,
    );

    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("b.pdf")).toBeInTheDocument();
    expect(within(rows[1]).getByText("a.pdf")).toBeInTheDocument();
  });

  it("shows per-criterion marks and total score", () => {
    const job = makeJob([
      candidate("a", "a.pdf", "complete", 0, 66.67, [
        evaluation("c-python", "strong", 1),
        evaluation("c-sql", "partial", 0.5),
      ]),
    ]);
    render(
      <Scorecard job={job} selectedId={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByText("Python")).toBeInTheDocument();
    expect(screen.getByText("SQL")).toBeInTheDocument();
    expect(screen.getByText("66.67")).toBeInTheDocument();
    expect(screen.getByLabelText(/python: strong/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/sql: partial/i)).toBeInTheDocument();
  });

  it("calls onSelect and marks the selected row", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const job = makeJob([
      candidate("a", "a.pdf", "complete", 0, 90),
    ]);
    render(
      <Scorecard job={job} selectedId="a" onSelect={onSelect} />,
    );
    await user.click(
      screen.getByRole("button", { name: /inspect a\.pdf/i }),
    );
    expect(onSelect).toHaveBeenCalledWith("a");
    expect(screen.getByRole("row", { name: /a\.pdf/i })).toHaveAttribute(
      "data-state",
      "selected",
    );
  });

  it("shows progress counts and empty state", () => {
    const { rerender } = render(
      <Scorecard job={makeJob([])} selectedId={null} onSelect={vi.fn()} />,
    );
    expect(screen.getByText(/no cvs/i)).toBeInTheDocument();
    rerender(
      <Scorecard
        job={makeJob([candidate("a", "a.pdf", "queued", 0)])}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/0 of 1/i)).toBeInTheDocument();
  });
});

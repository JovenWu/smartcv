import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateResult, JobSnapshot } from "@/types";
import App from "./App";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<(e: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  open() {
    this.onopen?.();
  }
}

const snapshot: JobSnapshot = {
  id: "job-1",
  title: "Backend Engineer",
  criteria: [{ id: "criterion-1", name: "Python", description: "", weight: 4 }],
  candidates: [],
  completed_count: 0,
  total_count: 0,
  is_final: false,
};

const queuedCandidate: CandidateResult = {
  id: "cand-1",
  filename: "alice.pdf",
  upload_order: 0,
  status: "queued",
  evaluations: [],
  total_score: null,
  error_message: null,
  retryable: false,
};

const doneCandidate: CandidateResult = {
  ...queuedCandidate,
  status: "complete",
  total_score: 100,
  evaluations: [
    {
      criterion_id: "criterion-1",
      status: "strong",
      confidence: 0.95,
      model_fraction: 1,
      evidence_span_id: "s1",
      manual_fraction: null,
      review_note: null,
    },
  ],
};

function route(url: string, init?: RequestInit): Response {
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  if (url === "/api/jobs" && init?.method === "POST")
    return json(snapshot, 201);
  if (url === "/api/jobs/job-1/cvs")
    return json({ candidates: [queuedCandidate], total_count: 1 }, 201);
  if (url.endsWith("/spans"))
    return json([
      { id: "s1", page_number: 1, text: "Five years of Python experience" },
    ]);
  if (url.endsWith("/preview")) return new Response(new Uint8Array([1]));
  throw new Error(`Unexpected request ${url}`);
}

describe("App", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        route(String(input), init),
      ),
    );
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("walks the full recruiter flow: role → upload → live results → evidence", async () => {
    const user = userEvent.setup();
    render(<App />);

    // 1. Define the role with a confirmed weight.
    await user.type(screen.getByLabelText(/role title/i), "Backend Engineer");
    await user.type(screen.getByLabelText(/criterion name/i), "Python");
    await user.type(screen.getByLabelText(/weight \(1–5\)/i), "4");
    await user.click(
      screen.getByRole("button", { name: /confirm weights/i }),
    );

    // 2. Dashboard appears with the confirmed role and live connection.
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe("/api/jobs/job-1/events");
    await act(async () => {
      source.open();
      source.emit("snapshot", snapshot);
    });
    expect(await screen.findByText(/no cvs uploaded/i)).toBeInTheDocument();
    expect(screen.getByText("Backend Engineer")).toBeInTheDocument();

    // 3. Upload one CV — queued row appears immediately from the response.
    const file = new File([new Uint8Array(64)], "alice.pdf", {
      type: "application/pdf",
    });
    await user.upload(screen.getByLabelText(/cv files/i), file);
    await user.click(screen.getByRole("button", { name: /upload 1 file/i }));
    expect(await screen.findByText("alice.pdf")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();

    // 4. SSE pushes the completed evaluation — score + rank update live.
    await act(async () => {
      source.emit("candidate.updated", {
        candidate: doneCandidate,
        completed_count: 1,
        total_count: 1,
      });
    });
    expect(await screen.findByText("#1")).toBeInTheDocument();
    expect(screen.getByText("100.00")).toBeInTheDocument();
    expect(screen.getByText("Complete")).toBeInTheDocument();

    // 5. Inspect → evidence panel shows the verified excerpt.
    await user.click(
      screen.getByRole("button", { name: /inspect alice\.pdf/i }),
    );
    expect(
      await screen.findByText(/Five years of Python experience/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /page 1/i }),
    ).toBeInTheDocument();

    // 6. job.complete flips the ranking to final and closes the stream.
    await act(async () => {
      source.emit(
        "job.complete",
        { ...snapshot, candidates: [doneCandidate], is_final: true,
          completed_count: 1, total_count: 1 },
      );
    });
    expect(await screen.findByText(/final ranking/i)).toBeInTheDocument();
    expect(source.closed).toBe(true);
  });

  it("keeps upload available only inside an active job", () => {
    render(<App />);
    expect(
      screen.queryByRole("button", { name: /upload/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /confirm weights/i }),
    ).toBeInTheDocument();
  });

  it("applies the stored theme to the document root", async () => {
    localStorage.setItem("smartcv-theme", "dark");
    render(<App />);
    await waitFor(() =>
      expect(document.documentElement.classList.contains("dark")).toBe(true),
    );
  });
});

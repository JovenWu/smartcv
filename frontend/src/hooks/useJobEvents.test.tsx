import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateResult, JobSnapshot } from "@/types";
import { useJobEvents } from "./useJobEvents";

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
  fail() {
    this.onerror?.();
  }
}

function job(overrides: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id: "job-1",
    title: "Engineer",
    criteria: [],
    candidates: [],
    completed_count: 0,
    total_count: 0,
    is_final: false,
    ...overrides,
  };
}

function candidate(id: string, status = "queued"): CandidateResult {
  return {
    id,
    filename: `${id}.pdf`,
    upload_order: 0,
    status: status as CandidateResult["status"],
    evaluations: [],
    total_score: null,
    error_message: null,
    retryable: false,
  };
}

describe("useJobEvents", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("subscribes to the job event stream and applies the snapshot", () => {
    const { result } = renderHook(() => useJobEvents("job-1"));
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe("/api/jobs/job-1/events");

    act(() => {
      source.open();
      source.emit("snapshot", job({ total_count: 2 }));
    });

    expect(result.current.live).toBe(true);
    expect(result.current.job?.total_count).toBe(2);
  });

  it("merges candidate updates idempotently by id", () => {
    const { result } = renderHook(() => useJobEvents("job-1"));
    const source = FakeEventSource.instances[0];
    act(() => source.emit("snapshot", job()));
    act(() =>
      source.emit("candidate.updated", {
        candidate: candidate("a"),
        completed_count: 0,
        total_count: 1,
      }),
    );
    act(() =>
      source.emit("candidate.updated", {
        candidate: { ...candidate("a"), status: "complete", total_score: 80 },
        completed_count: 1,
        total_count: 1,
      }),
    );

    const candidates = result.current.job!.candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0].status).toBe("complete");
    expect(result.current.job?.completed_count).toBe(1);
  });

  it("applies progress counts and closes on job.complete", () => {
    const { result } = renderHook(() => useJobEvents("job-1"));
    const source = FakeEventSource.instances[0];
    act(() => source.emit("snapshot", job()));
    act(() =>
      source.emit("job.progress", { completed_count: 3, total_count: 5 }),
    );
    expect(result.current.job?.completed_count).toBe(3);
    expect(result.current.job?.total_count).toBe(5);

    act(() => source.emit("job.complete", job({ is_final: true })));
    expect(result.current.job?.is_final).toBe(true);
    expect(source.closed).toBe(true);
  });

  it("resets state from a fresh snapshot after a reconnect", () => {
    const { result } = renderHook(() => useJobEvents("job-1"));
    const source = FakeEventSource.instances[0];
    act(() => source.emit("snapshot", job()));
    act(() =>
      source.emit("candidate.updated", {
        candidate: candidate("stale"),
        completed_count: 1,
        total_count: 3,
      }),
    );
    act(() => source.fail());
    expect(result.current.streamError).toBe(true);
    expect(result.current.live).toBe(false);

    // Browser reconnects → server resends the authoritative snapshot.
    act(() => {
      source.open();
      source.emit("snapshot", job({ total_count: 3 }));
    });
    expect(result.current.job?.candidates).toHaveLength(0);
    expect(result.current.job?.total_count).toBe(3);
  });

  it("closes the stream on unmount and ignores a null jobId", () => {
    const { unmount, rerender } = renderHook(
      ({ id }) => useJobEvents(id),
      { initialProps: { id: null as string | null } },
    );
    expect(FakeEventSource.instances).toHaveLength(0);
    rerender({ id: "job-9" });
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe("/api/jobs/job-9/events");
    unmount();
    expect(source.closed).toBe(true);
  });
});

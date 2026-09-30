import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  addCandidates,
  orderCandidates,
  setDecision,
  sortCandidates,
  useCandidates,
  __resetCandidatesForTests,
} from "@/lib/candidates"
import { __resetOpeningsForTests } from "@/lib/openings"
import type { Candidate } from "@/types"

const CANDIDATE: Candidate = {
  id: "c1",
  openingId: "o1",
  name: "Jane Doe",
  file: { filename: "jane.pdf", url: "/api/x", mimeType: "application/pdf" },
  status: "complete",
  uploadOrder: 0,
  uploadedAt: "2026-09-29T00:00:00Z",
  evaluations: [],
  totalScore: 80,
  isFinal: true,
  decision: "undecided",
  retryable: false,
}

class FakeEventSource {
  static CLOSED = 2
  static instances: FakeEventSource[] = []
  listeners = new Map<string, (e: MessageEvent) => void>()
  closed = false
  readyState = 1
  url: string
  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(name, fn)
  }
  close() {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }
  dispatch(name: string, data: unknown) {
    this.listeners.get(name)?.(
      new MessageEvent(name, { data: JSON.stringify(data) }),
    )
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeEventSource.instances = []
  __resetCandidatesForTests()
  __resetOpeningsForTests()
})

function stubFetch(implementation: typeof fetch) {
  vi.stubGlobal("fetch", vi.fn(implementation))
}

describe("useCandidates", () => {
  it("fetches candidates and opens an events stream", async () => {
    stubFetch(async (input) => {
      const url = String(input)
      if (url.endsWith("/candidates")) {
        return new Response(JSON.stringify([CANDIDATE]), { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    })
    vi.stubGlobal("EventSource", FakeEventSource)
    const { result } = renderHook(() => useCandidates("o1"))
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(result.current[0].id).toBe("c1")
    const es = FakeEventSource.instances[0]
    expect(es.url).toBe("/api/openings/o1/events")
  })

  it("applies candidate.updated events to the list", async () => {
    stubFetch(async () => new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal("EventSource", FakeEventSource)
    const { result } = renderHook(() => useCandidates("o1"))
    await waitFor(() =>
      expect(FakeEventSource.instances).toHaveLength(1),
    )
    const es = FakeEventSource.instances[0]
    act(() => {
      es.dispatch("candidate.updated", { candidate: CANDIDATE })
    })
    expect(result.current).toHaveLength(1)
    expect(result.current[0].name).toBe("Jane Doe")
    act(() => {
      es.dispatch("candidate.updated", {
        candidate: { ...CANDIDATE, totalScore: 95, decision: "shortlisted" },
      })
    })
    expect(result.current[0].totalScore).toBe(95)
    expect(result.current[0].decision).toBe("shortlisted")
  })

  it("replaces the list from the snapshot event", async () => {
    stubFetch(async () => new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal("EventSource", FakeEventSource)
    const { result } = renderHook(() => useCandidates("o1"))
    await waitFor(() =>
      expect(FakeEventSource.instances).toHaveLength(1),
    )
    act(() => {
      FakeEventSource.instances[0].dispatch("snapshot", {
        opening: { id: "o1" },
        candidates: [CANDIDATE],
      })
    })
    expect(result.current).toHaveLength(1)
  })

  it("reranks candidates by score as updates arrive", async () => {
    const low = { ...CANDIDATE, id: "low", totalScore: 40, uploadOrder: 0 }
    const mid = { ...CANDIDATE, id: "mid", totalScore: 60, uploadOrder: 1 }
    const queued = {
      ...CANDIDATE,
      id: "queued",
      status: "processing" as const,
      totalScore: null,
      uploadOrder: 2,
    }
    stubFetch(async () =>
      new Response(JSON.stringify([low, mid, queued]), { status: 200 }),
    )
    vi.stubGlobal("EventSource", FakeEventSource)
    const { result } = renderHook(() => useCandidates("o1"))
    await waitFor(() => expect(result.current).toHaveLength(3))
    // Highest score first; unscored last.
    expect(result.current.map((c) => c.id)).toEqual(["mid", "low", "queued"])
    // A completed evaluation overtakes lower scores.
    act(() => {
      FakeEventSource.instances[0].dispatch("candidate.updated", {
        candidate: { ...queued, status: "complete", totalScore: 95 },
      })
    })
    expect(result.current.map((c) => c.id)).toEqual(["queued", "mid", "low"])
  })

  it("reopens the stream when CVs arrive after opening.complete", async () => {
    stubFetch(async (input, init) => {
      const url = String(input)
      if (init?.method === "POST" && url.endsWith("/candidates")) {
        return new Response(
          JSON.stringify({
            candidates: [CANDIDATE],
            duplicates: [],
            totalCount: 1,
          }),
          { status: 201 },
        )
      }
      return new Response(JSON.stringify([]), { status: 200 })
    })
    vi.stubGlobal("EventSource", FakeEventSource)
    renderHook(() => useCandidates("o1"))
    await waitFor(() =>
      expect(FakeEventSource.instances).toHaveLength(1),
    )
    const first = FakeEventSource.instances[0]
    act(() => {
      first.dispatch("opening.complete", {
        opening: { id: "o1", isFinal: true },
        candidates: [CANDIDATE],
      })
    })
    expect(first.closed).toBe(true)
    await act(async () => {
      await addCandidates("o1", [
        new File(["x"], "new.pdf", { type: "application/pdf" }),
      ])
    })
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[1].closed).toBe(false)
  })
})

describe("addCandidates", () => {
  it("posts files as multipart and stores returned candidates", async () => {
    const upload = { ...CANDIDATE, status: "queued" as const }
    stubFetch(async (input, init) => {
      const url = String(input)
      if (init?.method === "POST" && url.endsWith("/candidates")) {
        return new Response(
          JSON.stringify({
            candidates: [upload],
            duplicates: [],
            totalCount: 1,
          }),
          { status: 201 },
        )
      }
      return new Response(JSON.stringify([]), { status: 200 })
    })
    vi.stubGlobal("EventSource", FakeEventSource)
    const { result } = renderHook(() => useCandidates("o1"))
    await waitFor(() =>
      expect(FakeEventSource.instances).toHaveLength(1),
    )
    await act(async () => {
      await addCandidates("o1", [
        new File(["x"], "jane.pdf", { type: "application/pdf" }),
      ])
    })
    expect(result.current).toHaveLength(1)
    expect(result.current[0].status).toBe("queued")
  })
})

describe("sortCandidates", () => {
  const scored = (
    id: string,
    totalScore: number | null,
    uploadOrder: number,
    extra?: Partial<Candidate>,
  ): Candidate => ({
    ...CANDIDATE,
    id,
    totalScore,
    uploadOrder,
    ...extra,
  })

  it("orders by score descending, unscored last", () => {
    const list = [
      scored("low", 40, 0),
      scored("unscored", null, 1),
      scored("high", 90, 2),
    ]
    expect(
      sortCandidates(list, { column: "score", dir: "desc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["high", "low", "unscored"])
  })

  it("orders by name ascending and descending", () => {
    const list = [
      scored("b", 10, 0, { name: "Beta" }),
      scored("a", 90, 1, { name: "alpha" }),
      scored("c", 50, 2, { name: "Gamma" }),
    ]
    expect(
      sortCandidates(list, { column: "name", dir: "asc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["a", "b", "c"])
    expect(
      sortCandidates(list, { column: "name", dir: "desc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["c", "b", "a"])
  })

  it("orders by a criterion column using the effective fraction", () => {
    const list = [
      scored("weak", 10, 0, {
        evaluations: [
          {
            criterionId: "python",
            status: "partial",
            confidence: 0.9,
            modelFraction: 0.5,
            evidenceSpanIds: [],
          },
        ],
      }),
      scored("reviewed", 50, 1, {
        evaluations: [
          {
            criterionId: "python",
            status: "reviewed",
            confidence: 0.4,
            modelFraction: 0.0,
            manualFraction: 1.0,
            evidenceSpanIds: [],
          },
        ],
      }),
      scored("none", 0, 2),
    ]
    // manualFraction (1.0) beats modelFraction (0.5); missing sinks.
    expect(
      sortCandidates(list, { column: "python", dir: "desc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["reviewed", "weak", "none"])
    // Missing values sink even ascending.
    expect(
      sortCandidates(list, { column: "python", dir: "asc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["weak", "reviewed", "none"])
  })

  it("breaks ties by upload order", () => {
    const list = [scored("b", 50, 1), scored("a", 50, 0)]
    expect(
      sortCandidates(list, { column: "score", dir: "desc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["a", "b"])
  })
})

describe("orderCandidates", () => {
  const candidate = (
    id: string,
    status: Candidate["status"],
    totalScore: number | null,
    uploadOrder: number,
    extra?: Partial<Candidate>,
  ): Candidate => ({
    ...CANDIDATE,
    id,
    status,
    totalScore,
    uploadOrder,
    ...extra,
  })

  it("pins in-flight candidates to the top under the default sort", () => {
    const list = [
      candidate("low", "complete", 40, 0),
      candidate("high", "complete", 90, 1),
      candidate("new-1", "queued", null, 2),
      candidate("new-2", "evaluating", null, 3),
    ]
    expect(
      orderCandidates(list, { column: "score", dir: "desc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["new-1", "new-2", "high", "low"])
  })

  it("does not pin when the user sorts by another column or direction", () => {
    const list = [
      candidate("low", "complete", 40, 0, { name: "Zed" }),
      candidate("new", "queued", null, 1, { name: "Ann" }),
    ]
    expect(
      orderCandidates(list, { column: "name", dir: "asc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["new", "low"])
    // Score ascending follows sort rules: unscored still sink.
    expect(
      orderCandidates(list, { column: "score", dir: "asc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["low", "new"])
  })
})

describe("setDecision", () => {
  it("patches the decision and updates the candidate", async () => {
    stubFetch(async (input, init) => {
      const url = String(input)
      if (init?.method === "PATCH" && url.endsWith("/decision")) {
        return new Response(
          JSON.stringify({ ...CANDIDATE, decision: "passed" }),
          { status: 200 },
        )
      }
      if (url.endsWith("/candidates")) {
        return new Response(JSON.stringify([CANDIDATE]), { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    })
    vi.stubGlobal("EventSource", FakeEventSource)
    const { result } = renderHook(() => useCandidates("o1"))
    await waitFor(() => expect(result.current).toHaveLength(1))
    await act(async () => {
      await setDecision("o1", "c1", "passed")
    })
    expect(result.current[0].decision).toBe("passed")
  })
})

import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  addCandidates,
  bulkSetDecision,
  orderCandidates,
  removeCandidate,
  setDecision,
  sortCandidates,
  useCandidates,
  useCandidatesStatus,
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

  it("orders by decision — shortlisted first descending", () => {
    const list = [
      candidate("rej", "complete", 50, 0, { decision: "passed" }),
      candidate("und", "complete", 80, 1, { decision: "undecided" }),
      candidate("short", "complete", 60, 2, { decision: "shortlisted" }),
    ]
    expect(
      orderCandidates(list, { column: "decision", dir: "desc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["short", "und", "rej"])
    expect(
      orderCandidates(list, { column: "decision", dir: "asc" }).map(
        (c) => c.id,
      ),
    ).toEqual(["rej", "und", "short"])
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

describe("useCandidatesStatus", () => {
  it("is loading until the first fetch resolves, then ready", async () => {
    let resolveList!: (response: Response) => void
    stubFetch((input) =>
      String(input).endsWith("/candidates")
        ? new Promise<Response>((resolve) => {
            resolveList = resolve
          })
        : Promise.resolve(new Response(JSON.stringify([]), { status: 200 })),
    )
    vi.stubGlobal("EventSource", FakeEventSource)
    const { result } = renderHook(() => useCandidatesStatus("o1"))
    expect(result.current).toBe("loading")
    await act(async () => {
      resolveList(
        new Response(JSON.stringify([CANDIDATE]), { status: 200 }),
      )
    })
    await waitFor(() => expect(result.current).toBe("ready"))
  })

  it("reports error when the initial fetch fails", async () => {
    stubFetch((input) =>
      String(input).endsWith("/candidates")
        ? Promise.resolve(new Response("boom", { status: 500 }))
        : Promise.resolve(
            new Response(JSON.stringify([]), { status: 200 }),
          ),
    )
    vi.stubGlobal("EventSource", FakeEventSource)
    const { result } = renderHook(() => useCandidatesStatus("o1"))
    await waitFor(() => expect(result.current).toBe("error"))
  })
})

describe("candidate store SSE events", () => {
  it("drops the row on candidate.deleted", async () => {
    const other = { ...CANDIDATE, id: "c2", uploadOrder: 1 }
    stubFetch(async (input) =>
      String(input).endsWith("/candidates")
        ? new Response(JSON.stringify([CANDIDATE, other]), {
            status: 200,
          })
        : new Response(JSON.stringify([]), { status: 200 }),
    )
    vi.stubGlobal("EventSource", FakeEventSource)
    const { result } = renderHook(() => useCandidates("o1"))
    await waitFor(() => expect(result.current).toHaveLength(2))
    act(() => {
      FakeEventSource.instances[0].dispatch("candidate.deleted", {
        candidateId: "c1",
      })
    })
    expect(result.current.map((c) => c.id)).toEqual(["c2"])
  })

  it("refetches the list once on candidates.updated", async () => {
    let listResponse = [CANDIDATE]
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/candidates")
        ? new Response(JSON.stringify(listResponse), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("EventSource", FakeEventSource)
    const { result } = renderHook(() => useCandidates("o1"))
    await waitFor(() => expect(result.current).toHaveLength(1))
    listResponse = [{ ...CANDIDATE, decision: "shortlisted" }]
    const candidatesCalls = () =>
      fetchMock.mock.calls.filter((call) =>
        String(call[0]).endsWith("/candidates"),
      ).length
    const before = candidatesCalls()
    act(() => {
      FakeEventSource.instances[0].dispatch("candidates.updated", {
        candidateIds: ["c1"],
      })
    })
    await waitFor(() =>
      expect(result.current[0].decision).toBe("shortlisted"),
    )
    expect(candidatesCalls() - before).toBe(1)
  })

  it("closes the stream and reports error on opening.deleted", async () => {
    stubFetch(async (input) =>
      String(input).endsWith("/candidates")
        ? new Response(JSON.stringify([CANDIDATE]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 }),
    )
    vi.stubGlobal("EventSource", FakeEventSource)
    const { result } = renderHook(() => ({
      list: useCandidates("o1"),
      status: useCandidatesStatus("o1"),
    }))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    const es = FakeEventSource.instances[0]
    act(() => {
      es.dispatch("opening.deleted", { openingId: "o1" })
    })
    expect(es.closed).toBe(true)
    expect(result.current.list).toHaveLength(0)
    expect(result.current.status).toBe("error")
    // Terminal — no reconnect, no refetch.
    await act(async () => {})
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  it("ignores malformed event payloads", async () => {
    stubFetch(async () =>
      new Response(JSON.stringify([]), { status: 200 }),
    )
    vi.stubGlobal("EventSource", FakeEventSource)
    const { result } = renderHook(() => useCandidates("o1"))
    await waitFor(() =>
      expect(FakeEventSource.instances).toHaveLength(1),
    )
    const es = FakeEventSource.instances[0]
    expect(() =>
      act(() => {
        es.listeners.get("candidate.updated")?.(
          new MessageEvent("candidate.updated", { data: "{not json" }),
        )
      }),
    ).not.toThrow()
    expect(result.current).toHaveLength(0)
  })

  it("collapses a burst of events into one openings refetch", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === "/api/openings") {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.endsWith("/candidates")) {
        return new Response(JSON.stringify([CANDIDATE]), { status: 200 })
      }
      return new Response(JSON.stringify([]), { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("EventSource", FakeEventSource)
    renderHook(() => useCandidates("o1"))
    await waitFor(() =>
      expect(FakeEventSource.instances).toHaveLength(1),
    )
    const es = FakeEventSource.instances[0]
    vi.useFakeTimers()
    try {
      const openingsCalls = () =>
        fetchMock.mock.calls.filter(
          (call) => String(call[0]) === "/api/openings",
        ).length
      expect(openingsCalls()).toBe(0)
      act(() => {
        es.dispatch("opening.progress", {})
        es.dispatch("candidate.updated", { candidate: CANDIDATE })
        es.dispatch("candidate.deleted", { candidateId: "unknown" })
        es.dispatch("opening.progress", {})
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600)
      })
      expect(openingsCalls()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("useCandidates remount", () => {
  it("keeps the cached list while silently revalidating", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/candidates")
        ? new Response(JSON.stringify([CANDIDATE]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("EventSource", FakeEventSource)
    const first = renderHook(() => useCandidates("o1"))
    await waitFor(() => expect(first.result.current).toHaveLength(1))
    first.unmount()

    // Second mount: the refetch hangs, but the stale list stays rendered.
    let resolveList!: (response: Response) => void
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      String(input).endsWith("/candidates")
        ? new Promise<Response>((resolve) => {
            resolveList = resolve
          })
        : Promise.resolve(
            new Response(JSON.stringify([]), { status: 200 }),
          ),
    )
    const second = renderHook(() => useCandidates("o1"))
    expect(second.result.current).toHaveLength(1)
    expect(second.result.current[0].id).toBe("c1")
    await act(async () => {
      resolveList(
        new Response(JSON.stringify([{ ...CANDIDATE, id: "c2" }]), {
          status: 200,
        }),
      )
    })
    await waitFor(() =>
      expect(second.result.current[0].id).toBe("c2"),
    )
  })
})

describe("removeCandidate", () => {
  it("issues DELETE and drops the row immediately", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (init?.method === "DELETE") {
          return new Response(null, { status: 204 })
        }
        if (url.endsWith("/candidates")) {
          return new Response(JSON.stringify([CANDIDATE]), {
            status: 200,
          })
        }
        return new Response(JSON.stringify([]), { status: 200 })
      },
    )
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("EventSource", FakeEventSource)
    const { result } = renderHook(() => useCandidates("o1"))
    await waitFor(() => expect(result.current).toHaveLength(1))
    await act(async () => {
      await removeCandidate("o1", "c1")
    })
    const deleteCall = fetchMock.mock.calls.find(
      (call) => call[1]?.method === "DELETE",
    )
    expect(String(deleteCall?.[0])).toBe("/api/openings/o1/candidates/c1")
    expect(result.current).toHaveLength(0)
  })
})

describe("bulkSetDecision", () => {
  it("posts the bulk decision and refetches the list", async () => {
    let listResponse = [CANDIDATE]
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (init?.method === "POST" && url.endsWith("/bulk-decision")) {
          return new Response(JSON.stringify({ updated: 1 }), {
            status: 200,
          })
        }
        if (url.endsWith("/candidates")) {
          return new Response(JSON.stringify(listResponse), {
            status: 200,
          })
        }
        return new Response(JSON.stringify([]), { status: 200 })
      },
    )
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("EventSource", FakeEventSource)
    const { result } = renderHook(() => useCandidates("o1"))
    await waitFor(() => expect(result.current).toHaveLength(1))
    listResponse = [{ ...CANDIDATE, decision: "passed" }]
    let updated = 0
    await act(async () => {
      updated = (
        await bulkSetDecision("o1", ["c1"], "passed")
      ).updated
    })
    expect(updated).toBe(1)
    const post = fetchMock.mock.calls.find((call) =>
      String(call[0]).endsWith("/bulk-decision"),
    )
    expect(post?.[1]?.method).toBe("POST")
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({
      candidateIds: ["c1"],
      decision: "passed",
    })
    await waitFor(() =>
      expect(result.current[0].decision).toBe("passed"),
    )
  })
})

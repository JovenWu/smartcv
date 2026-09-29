import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  addCandidates,
  setDecision,
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
  static instances: FakeEventSource[] = []
  listeners = new Map<string, (e: MessageEvent) => void>()
  closed = false
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
})

describe("addCandidates", () => {
  it("posts files as multipart and stores returned candidates", async () => {
    const upload = { ...CANDIDATE, status: "queued" as const }
    stubFetch(async (input, init) => {
      const url = String(input)
      if (init?.method === "POST" && url.endsWith("/candidates")) {
        return new Response(
          JSON.stringify({ candidates: [upload], totalCount: 1 }),
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

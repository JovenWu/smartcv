import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  addOpening,
  mergeSuggestions,
  updateOpening,
  useOpenings,
  useOpeningsStatus,
  __resetOpeningsForTests,
} from "@/lib/openings"

const OPENING = {
  id: "x",
  title: "PM",
  department: "Engineering",
  location: "",
  description: "",
  source: { type: "manual" },
  status: "open",
  criteria: [],
  createdAt: "2026-09-29T00:00:00Z",
  candidates: 0,
  pendingReview: 0,
  isFinal: false,
}

afterEach(() => {
  vi.unstubAllGlobals()
  __resetOpeningsForTests()
})

describe("useOpenings", () => {
  it("fetches the opening list on subscribe", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify([OPENING]), { status: 200 }),
      )
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useOpenings())
    await waitFor(() => expect(result.current).toHaveLength(1))
    expect(fetchMock.mock.calls[0][0]).toBe("/api/openings")
    expect(result.current[0].url).toBe("/openings/x")
  })
})

describe("useOpeningsStatus", () => {
  it("is loading until the first fetch resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify([OPENING]), { status: 200 }),
      ),
    )
    const { result } = renderHook(() => useOpeningsStatus())
    expect(result.current).toBe("loading")
    await waitFor(() => expect(result.current).toBe("ready"))
  })

  it("reports error when the list fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 500 })),
    )
    const { result } = renderHook(() => useOpeningsStatus())
    await waitFor(() => expect(result.current).toBe("error"))
  })
})

describe("addOpening", () => {
  it("posts to the api and exposes the opening", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(OPENING), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([OPENING]), { status: 200 }),
      )
    vi.stubGlobal("fetch", fetchMock)
    const opening = await addOpening({
      title: "PM",
      criteria: [{ name: "Strategy Work", weight: 4 }],
    })
    expect(fetchMock.mock.calls[0][0]).toBe("/api/openings")
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(body.criteria[0].id).toBe("strategy-work")
    expect(opening.id).toBe("x")
  })
})

describe("addOpening criteria backstop", () => {
  it("turns stated levels into criteria when not covered", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(OPENING), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([OPENING]), { status: 200 }),
      )
    vi.stubGlobal("fetch", fetchMock)
    await addOpening({
      title: "PM",
      experienceLevel: "3-5 years",
      educationLevel: "Bachelor's degree",
      criteria: [{ name: "Strategy", weight: 4 }],
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    const names = body.criteria.map((c: { name: string }) => c.name)
    expect(names).toContain("Experience: 3-5 years")
    expect(names).toContain("Education: Bachelor's degree")
  })

  it("does not duplicate a criterion that already covers it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(OPENING), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([OPENING]), { status: 200 }),
      )
    vi.stubGlobal("fetch", fetchMock)
    await addOpening({
      title: "PM",
      experienceLevel: "5+ years",
      criteria: [{ name: "5+ years product experience", weight: 4 }],
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(
      body.criteria.map((c: { name: string }) => c.name),
    ).toEqual(["5+ years product experience"])
  })
})

describe("updateOpening", () => {
  it("patches the opening and refreshes the list", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([OPENING]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...OPENING, title: "Senior PM" }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ ...OPENING, title: "Senior PM" }]),
          { status: 200 },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)
    const { result } = renderHook(() => useOpenings())
    await waitFor(() => expect(result.current).toHaveLength(1))
    await updateOpening("x", { title: "Senior PM" })
    expect(fetchMock.mock.calls[1][0]).toBe("/api/openings/x")
    expect(fetchMock.mock.calls[1][1]?.method).toBe("PATCH")
    await waitFor(() =>
      expect(result.current[0].title).toBe("Senior PM"),
    )
  })
})

describe("mergeSuggestions", () => {
  it("appends new criteria and skips duplicates", () => {
    const merged = mergeSuggestions(
      [{ name: "Python", weight: 4 }],
      [
        {
          skill: "Kubernetes",
          criterion: {
            name: "Kubernetes",
            description: "d",
            suggestedWeight: 4,
            required: true,
            confidence: 0.9,
          },
        },
        { skill: "Python", matchedCriterionId: "python" },
        {
          skill: "python",
          criterion: {
            name: "Python",
            description: "dup",
            suggestedWeight: 2,
            required: false,
            confidence: 0.5,
          },
        },
      ],
    )
    expect(merged).toHaveLength(2)
    expect(merged[1]).toEqual({
      name: "Kubernetes",
      description: "d",
      weight: 4,
      required: true,
      suggestedWeight: 4,
      suggestionConfidence: 0.9,
    })
  })
})

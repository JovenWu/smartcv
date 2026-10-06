import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { apiFetch, candidatesApi, openingsApi } from "@/lib/api"
import {
  getSessionSnapshot,
  refreshSession,
  __resetSessionForTests,
} from "@/lib/auth"
import { useSession } from "@/hooks/use-session"

afterEach(() => {
  vi.unstubAllGlobals()
  __resetSessionForTests()
})

describe("apiFetch", () => {
  it("returns the parsed body on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      ),
    )
    await expect(apiFetch<{ ok: boolean }>("/api/x")).resolves.toEqual({
      ok: true,
    })
  })

  it("throws the API detail message on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "Unknown opening" }), {
          status: 404,
        }),
      ),
    )
    await expect(apiFetch("/api/x")).rejects.toThrow("Unknown opening")
  })

  it("falls back to the status code on non-JSON errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("oops", { status: 500 })),
    )
    await expect(apiFetch("/api/x")).rejects.toThrow("500")
  })

  it("resolves undefined on a 204 No Content response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    )
    await expect(apiFetch("/api/x")).resolves.toBeUndefined()
  })

  it("resolves undefined on an OK response with an empty body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 200 })),
    )
    await expect(apiFetch("/api/x")).resolves.toBeUndefined()
  })

  it("clears the session and redirects to /login on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              auth_required: true,
              authenticated: true,
              username: "jane",
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ detail: "Session expired" }), {
            status: 401,
          }),
        ),
    )
    const assign = vi.fn()
    vi.stubGlobal("location", { pathname: "/", assign })
    await refreshSession()
    expect(getSessionSnapshot()?.authenticated).toBe(true)
    await expect(apiFetch("/api/x")).rejects.toThrow("Session expired")
    expect(assign).toHaveBeenCalledWith("/login")
    expect(getSessionSnapshot()?.authenticated).toBe(false)
  })

  it("still throws on 401 but skips the redirect when on /login", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "Bad credentials" }), {
          status: 401,
        }),
      ),
    )
    const assign = vi.fn()
    vi.stubGlobal("location", { pathname: "/login", assign })
    await expect(apiFetch("/api/x")).rejects.toThrow("Bad credentials")
    expect(assign).not.toHaveBeenCalled()
  })
})

describe("openingsApi", () => {
  it("create posts a camelCase body to /api/openings", async () => {
    const payload = {
      id: "x",
      title: "PM",
      department: "",
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
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(payload), { status: 201 }),
      )
    vi.stubGlobal("fetch", fetchMock)
    await openingsApi.create({
      title: "PM",
      employmentType: "full_time",
      skills: ["Roadmaps"],
      source: { type: "manual" },
      criteria: [
        {
          id: "strategy",
          name: "Strategy",
          description: "",
          weight: 4,
          required: true,
        },
      ],
    })
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe("/api/openings")
    expect(init?.method).toBe("POST")
    const body = JSON.parse(init?.body as string)
    expect(body.title).toBe("PM")
    expect(body.employmentType).toBe("full_time")
    expect(body.criteria[0].id).toBe("strategy")
    expect(body.criteria[0].required).toBe(true)
  })

  it("importLink posts the url and returns a draft", async () => {
    const draft = {
      title: "Backend Engineer",
      source: { type: "link", url: "https://boards.example/job/1" },
      criteria: [{ name: "Python", suggestedWeight: 4 }],
      warnings: [],
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(draft), { status: 200 }),
      )
    vi.stubGlobal("fetch", fetchMock)
    const result = await openingsApi.importLink("https://boards.example/job/1")
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe("/api/openings/import/link")
    expect(JSON.parse(init?.body as string).url).toBe(
      "https://boards.example/job/1",
    )
    expect(result.title).toBe("Backend Engineer")
  })

  it("importFile posts multipart form data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          title: "Ad",
          source: { type: "file", filename: "ad.pdf" },
          criteria: [],
          warnings: [],
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const file = new File(["x"], "ad.pdf", { type: "application/pdf" })
    await openingsApi.importFile(file)
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe("/api/openings/import/file")
    const body = init?.body
    expect(body).toBeInstanceOf(FormData)
    expect((body as FormData).get("file")).toBeInstanceOf(File)
  })

  it("remove issues DELETE /api/openings/{id} and resolves undefined", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(openingsApi.remove("o1")).resolves.toBeUndefined()
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe("/api/openings/o1")
    expect(init?.method).toBe("DELETE")
  })
})

describe("candidatesApi", () => {
  it("list GETs /api/openings/{id}/candidates", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(candidatesApi.list("o1")).resolves.toEqual([])
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe("/api/openings/o1/candidates")
    expect(init?.method).toBeUndefined()
  })

  it("remove issues DELETE on the candidate resource", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)
    await expect(
      candidatesApi.remove("o1", "c1"),
    ).resolves.toBeUndefined()
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe("/api/openings/o1/candidates/c1")
    expect(init?.method).toBe("DELETE")
  })

  it("bulkSetDecision POSTs ids + decision to /candidates/bulk-decision", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ updated: 2 }), { status: 200 }),
      )
    vi.stubGlobal("fetch", fetchMock)
    const result = await candidatesApi.bulkSetDecision(
      "o1",
      ["c1", "c2"],
      "passed",
    )
    expect(result.updated).toBe(2)
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe("/api/openings/o1/candidates/bulk-decision")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(init?.body as string)).toEqual({
      candidateIds: ["c1", "c2"],
      decision: "passed",
    })
  })

  it("retry POSTs to /candidates/{cid}/retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "c1" }), { status: 200 }),
      )
    vi.stubGlobal("fetch", fetchMock)
    await candidatesApi.retry("o1", "c1")
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe("/api/openings/o1/candidates/c1/retry")
    expect(init?.method).toBe("POST")
  })

  it("spans GETs /candidates/{cid}/spans", async () => {
    const spans = [{ id: "s1", pageNumber: 2, text: "excerpt" }]
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(spans), { status: 200 }),
      )
    vi.stubGlobal("fetch", fetchMock)
    await expect(candidatesApi.spans("o1", "c1")).resolves.toEqual(spans)
    const [path, init] = fetchMock.mock.calls[0]
    expect(path).toBe("/api/openings/o1/candidates/c1/spans")
    expect(init?.method).toBeUndefined()
  })
})

describe("useSession store", () => {
  it("shares one session fetch across consumers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          auth_required: true,
          authenticated: true,
          username: "jane",
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal("fetch", fetchMock)
    const first = renderHook(() => useSession())
    const second = renderHook(() => useSession())
    await waitFor(() => {
      expect(first.result.current?.username).toBe("jane")
      expect(second.result.current?.username).toBe("jane")
    })
    const sessionCalls = fetchMock.mock.calls.filter(
      (call) => String(call[0]) === "/api/auth/session",
    )
    expect(sessionCalls).toHaveLength(1)
  })

  it("resolves to signed-out when the session check fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("down", { status: 500 })),
    )
    const session = await refreshSession()
    expect(session.authenticated).toBe(false)
    expect(getSessionSnapshot()?.authenticated).toBe(false)
  })
})

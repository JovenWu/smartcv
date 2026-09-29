import { afterEach, describe, expect, it, vi } from "vitest"

import { apiFetch, openingsApi } from "@/lib/api"

afterEach(() => vi.unstubAllGlobals())

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
})

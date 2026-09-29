import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { openingsApi } from "@/lib/api"
import { ManualOpeningForm } from "@/components/manual-opening-form"

vi.mock("@/lib/api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api")>()
  return {
    ...actual,
    openingsApi: {
      ...actual.openingsApi,
      suggestCriteria: vi.fn(),
    },
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("ManualOpeningForm skill suggestions", () => {
  it("debounces skill input and appends suggested criteria", async () => {
    vi.useFakeTimers()
    const suggest = vi.mocked(openingsApi.suggestCriteria)
    suggest.mockResolvedValue({
      suggestions: [
        {
          skill: "GraphQL",
          criterion: {
            name: "GraphQL",
            description: "Production GraphQL API work.",
            suggestedWeight: 4,
            required: false,
            confidence: 0.9,
          },
        },
      ],
    })
    render(<ManualOpeningForm onDone={() => {}} />)
    const skills = screen.getByLabelText("Skills")

    // Typing inside the debounce window must not send requests.
    fireEvent.change(skills, { target: { value: "Graph" } })
    act(() => void vi.advanceTimersByTime(300))
    fireEvent.change(skills, { target: { value: "GraphQL" } })
    act(() => void vi.advanceTimersByTime(300))
    expect(suggest).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(suggest).toHaveBeenCalledOnce()
    expect(suggest.mock.calls[0][0].skills).toEqual(["GraphQL"])
    // Skills input + the new criterion row both display the term.
    expect(screen.getAllByDisplayValue("GraphQL")).toHaveLength(2)
    expect(
      screen.getAllByPlaceholderText("e.g. React experience"),
    ).toHaveLength(1)
  })

  it("skips skills already covered by an existing criterion name", async () => {
    vi.useFakeTimers()
    const suggest = vi.mocked(openingsApi.suggestCriteria)
    render(
      <ManualOpeningForm
        onDone={() => {}}
        initial={{ criteria: [{ name: "Python", weight: 3 }] }}
      />,
    )
    fireEvent.change(screen.getByLabelText("Skills"), {
      target: { value: "Python" },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    expect(suggest).not.toHaveBeenCalled()
    expect(
      screen.getAllByPlaceholderText("e.g. React experience"),
    ).toHaveLength(1)
  })

  it("sends the filled role context with the suggestion request", async () => {
    vi.useFakeTimers()
    const suggest = vi.mocked(openingsApi.suggestCriteria)
    suggest.mockResolvedValue({ suggestions: [] })
    render(<ManualOpeningForm onDone={() => {}} />)
    fireEvent.change(screen.getByLabelText("Role title"), {
      target: { value: "Backend Engineer" },
    })
    fireEvent.change(screen.getByLabelText("Department"), {
      target: { value: "Platform" },
    })
    fireEvent.change(screen.getByLabelText("Skills"), {
      target: { value: "Go" },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700)
    })
    const request = suggest.mock.calls[0][0]
    expect(request.title).toBe("Backend Engineer")
    expect(request.department).toBe("Platform")
    expect(request.skills).toEqual(["Go"])
  })
})

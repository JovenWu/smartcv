import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { NavOpenings } from "@/components/nav-openings"
import { SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  removeOpening,
  setOpeningArchived,
  type Opening,
} from "@/lib/openings"

vi.mock("@/lib/openings", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/openings")>()
  return {
    ...actual,
    refreshOpenings: vi.fn().mockResolvedValue(undefined),
    useOpeningsStatus: vi.fn(() => "ready"),
    setOpeningArchived: vi.fn().mockResolvedValue(undefined),
    removeOpening: vi.fn().mockResolvedValue(undefined),
  }
})

beforeAll(() => {
  Object.assign(window.HTMLElement.prototype, {
    hasPointerCapture: () => false,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    scrollIntoView: () => {},
  })
})

function makeOpening(overrides: Partial<Opening>): Opening {
  return {
    id: "1",
    title: "Backend Engineer",
    department: "Engineering",
    location: "",
    description: "",
    source: { type: "manual" },
    status: "open",
    criteria: [],
    createdAt: "2026-09-30T00:00:00Z",
    candidates: 0,
    pendingReview: 0,
    url: "/openings/1",
    ...overrides,
  }
}

function renderNav(items: Opening[]) {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <SidebarProvider>
          <NavOpenings items={items} />
        </SidebarProvider>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

describe("NavOpenings", () => {
  it("never lists archived openings", () => {
    renderNav([
      makeOpening({ id: "1", title: "Backend Engineer" }),
      makeOpening({
        id: "2",
        title: "Old Role",
        status: "archived",
        url: "/openings/2",
      }),
    ])
    expect(
      screen.getByRole("link", { name: /Backend Engineer/ }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("link", { name: /Old Role/ }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Actions for Old Role" }),
    ).not.toBeInTheDocument()
  })

  it("archives an opening from the item menu", async () => {
    const user = userEvent.setup()
    renderNav([makeOpening({ id: "9", title: "Designer", url: "/openings/9" })])
    await user.click(
      screen.getByRole("button", { name: "Actions for Designer" }),
    )
    await user.click(await screen.findByRole("menuitem", { name: "Archive" }))
    expect(setOpeningArchived).toHaveBeenCalledWith("9", true)
  })

  it("deletes an opening through the confirm dialog", async () => {
    const user = userEvent.setup()
    renderNav([makeOpening({ id: "9", title: "Designer", url: "/openings/9" })])
    await user.click(
      screen.getByRole("button", { name: "Actions for Designer" }),
    )
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }))

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Delete opening?")).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "Delete" }))
    expect(removeOpening).toHaveBeenCalledWith("9")
  })
})

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { CvViewerLayout, CvViewerProvider } from "@/components/cv-viewer"
import { useCvViewer } from "@/components/cv-viewer-context"
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar"
import type { Candidate } from "@/types"

const CANDIDATE: Candidate = {
  id: "c1",
  openingId: "o1",
  name: "Ada Lovelace",
  file: {
    filename: "ada.pdf",
    url: "/api/files/ada.pdf",
    mimeType: "application/pdf",
  },
  status: "complete",
  uploadOrder: 0,
  uploadedAt: "2026-09-30T00:00:00Z",
  evaluations: [],
  totalScore: 4,
  isFinal: true,
  decision: "undecided",
  retryable: false,
}

function Trigger() {
  const { openCv } = useCvViewer()
  return <button onClick={() => openCv(CANDIDATE)}>Open CV</button>
}

function SidebarProbe() {
  const { open, toggleSidebar } = useSidebar()
  return (
    <>
      <span data-testid="sidebar-state">{open ? "expanded" : "collapsed"}</span>
      <button onClick={toggleSidebar}>Toggle sidebar</button>
    </>
  )
}

function renderViewer() {
  return render(
    <SidebarProvider>
      <CvViewerProvider>
        <SidebarProbe />
        <CvViewerLayout>
          <div data-testid="page">
            <Trigger />
          </div>
        </CvViewerLayout>
      </CvViewerProvider>
    </SidebarProvider>,
  )
}

describe("CvViewerLayout", () => {
  it("never remounts children when a CV opens and closes", async () => {
    const user = userEvent.setup()
    renderViewer()
    const page = screen.getByTestId("page")

    await user.click(screen.getByRole("button", { name: "Open CV" }))
    // Viewer panel is open…
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument()
    // …and the page subtree is literally the same DOM node — no remount.
    expect(screen.getByTestId("page")).toBe(page)

    await user.click(screen.getByRole("button", { name: "Close CV" }))
    expect(screen.queryByText("Ada Lovelace")).not.toBeInTheDocument()
    expect(screen.getByTestId("page")).toBe(page)
  })

  it("collapses the sidebar for the viewer and restores it on close", async () => {
    const user = userEvent.setup()
    renderViewer()
    const state = () => screen.getByTestId("sidebar-state")
    expect(state()).toHaveTextContent("expanded")

    await user.click(screen.getByRole("button", { name: "Open CV" }))
    expect(state()).toHaveTextContent("collapsed")

    // The collapse is not a lock — the user can still toggle the sidebar.
    await user.click(screen.getByRole("button", { name: "Toggle sidebar" }))
    expect(state()).toHaveTextContent("expanded")
    await user.click(screen.getByRole("button", { name: "Toggle sidebar" }))
    expect(state()).toHaveTextContent("collapsed")

    await user.click(screen.getByRole("button", { name: "Close CV" }))
    expect(state()).toHaveTextContent("expanded")
  })
})

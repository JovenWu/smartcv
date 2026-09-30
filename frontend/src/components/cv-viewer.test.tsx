import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import { CvViewerLayout, CvViewerProvider } from "@/components/cv-viewer"
import { useCvViewer } from "@/components/cv-viewer-context"
import { SidebarProvider } from "@/components/ui/sidebar"
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

function renderViewer() {
  return render(
    <SidebarProvider>
      <CvViewerProvider>
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
})

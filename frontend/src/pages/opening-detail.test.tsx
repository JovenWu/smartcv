import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { CvViewer } from "@/components/cv-viewer-context"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { Candidate, Opening } from "@/types"

// jsdom lacks pointer-capture/scroll APIs Radix menus rely on.
for (const key of ["hasPointerCapture", "releasePointerCapture"]) {
  if (!Element.prototype[key as keyof Element])
    Object.assign(Element.prototype, { [key]: () => false })
}
if (!Element.prototype.setPointerCapture)
  Object.assign(Element.prototype, { setPointerCapture: () => {} })
if (!Element.prototype.scrollIntoView)
  Object.assign(Element.prototype, { scrollIntoView: () => {} })

const mocks = vi.hoisted(() => ({
  candidates: [] as Candidate[],
  candidatesStatus: "ready" as "idle" | "loading" | "ready" | "error",
  openings: [] as Opening[],
  openingsStatus: "ready" as "idle" | "loading" | "ready" | "error",
  viewer: { selected: null as Candidate | null, openCv: vi.fn(), closeCv: vi.fn() } as CvViewer,
  spans: vi.fn<() => Promise<import("@/types").EvidenceSpan[]>>(),
  addCandidates: vi.fn(),
  bulkSetDecision: vi.fn(),
  removeCandidate: vi.fn(),
  retryCandidate: vi.fn(),
  reviewCriterion: vi.fn(),
  setDecision: vi.fn(),
}))

vi.mock("@/lib/candidates", () => ({
  addCandidates: mocks.addCandidates,
  bulkSetDecision: mocks.bulkSetDecision,
  duplicateNotice: () => null,
  IN_FLIGHT_STATUSES: new Set(["queued", "extracting", "evaluating"]),
  orderCandidates: (list: Candidate[]) => list,
  removeCandidate: mocks.removeCandidate,
  retryCandidate: mocks.retryCandidate,
  reviewCriterion: mocks.reviewCriterion,
  setDecision: mocks.setDecision,
  useCandidates: () => mocks.candidates,
  useCandidatesStatus: () => mocks.candidatesStatus,
}))

vi.mock("@/lib/openings", () => ({
  openingMeta: () => "Engineering · Berlin",
  refreshOpenings: () => Promise.resolve(),
  useOpenings: () => mocks.openings,
  useOpeningsStatus: () => mocks.openingsStatus,
}))

vi.mock("@/lib/api", () => ({
  candidatesApi: { spans: mocks.spans },
}))

vi.mock("@/components/cv-viewer-context", () => ({
  useCvViewer: () => mocks.viewer,
}))

vi.mock("@formkit/auto-animate/react", () => ({
  useAutoAnimate: () => [null],
}))

import OpeningDetailPage from "@/pages/opening-detail"

const OPENING: Opening = {
  id: "o1",
  title: "Frontend Engineer",
  department: "Engineering",
  location: "Berlin",
  description: "Build quiet interfaces.",
  skills: ["React", "TypeScript"],
  status: "open",
  source: { type: "manual" },
  criteria: [
    { id: "python", name: "Python", description: "", weight: 4, required: true },
    { id: "react", name: "React", description: "", weight: 3 },
  ],
  createdAt: "2026-09-29T00:00:00Z",
  closesAt: "2026-10-15T00:00:00Z",
  candidates: 2,
  pendingReview: 1,
}

const JANE: Candidate = {
  id: "c1",
  openingId: "o1",
  name: "Jane Doe",
  file: { filename: "jane.pdf", url: "/jane.pdf", mimeType: "application/pdf" },
  status: "complete",
  uploadOrder: 0,
  uploadedAt: "2026-09-29T01:00:00Z",
  evaluations: [
    {
      criterionId: "python",
      status: "needs_review",
      confidence: 0.4,
      modelFraction: 0.5,
      evidenceSpanIds: ["s1"],
      rationale: "Unclear depth of Python experience.",
    },
    {
      criterionId: "react",
      status: "strong",
      confidence: 0.9,
      modelFraction: 1,
      evidenceSpanIds: ["s2"],
      rationale: "Five years of React.",
    },
  ],
  totalScore: 72,
  isFinal: true,
  decision: "undecided",
  retryable: false,
}

const BOB: Candidate = {
  ...JANE,
  id: "c2",
  name: "Bob Ruiz",
  status: "failed",
  errorMessage: "File could not be parsed",
  evaluations: [],
  totalScore: null,
  isFinal: true,
  retryable: true,
}

function renderPage(id = "o1") {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[`/openings/${id}`]}>
        <Routes>
          <Route path="/openings/:id" element={<OpeningDetailPage />} />
          <Route path="/" element={<div>home-route</div>} />
        </Routes>
      </MemoryRouter>
    </TooltipProvider>,
  )
}

beforeEach(() => {
  mocks.candidates = [JANE, BOB]
  mocks.candidatesStatus = "ready"
  mocks.openings = [OPENING]
  mocks.openingsStatus = "ready"
  mocks.viewer.selected = null
  for (const fn of Object.values(mocks))
    if (typeof fn === "function" && "mockReset" in fn) fn.mockReset()
  mocks.bulkSetDecision.mockResolvedValue({ updated: 2 })
  mocks.removeCandidate.mockResolvedValue(undefined)
  mocks.retryCandidate.mockResolvedValue(undefined)
  mocks.reviewCriterion.mockResolvedValue({
    criterionId: "python",
    status: "reviewed",
    confidence: 1,
    modelFraction: 1,
    evidenceSpanIds: [],
  })
  mocks.setDecision.mockResolvedValue(JANE)
  mocks.spans.mockResolvedValue([
    { id: "s1", pageNumber: 2, text: "Built internal Python tooling" },
  ])
})

describe("OpeningDetailPage", () => {
  it("renders the summary header and scorecard rows", () => {
    renderPage()
    expect(
      screen.getByRole("heading", { name: "Frontend Engineer" }),
    ).toBeInTheDocument()
    expect(
      screen.getByText("Engineering · Berlin · Closes Oct 15, 2026"),
    ).toBeInTheDocument()
    expect(screen.getByText("Open")).toBeInTheDocument()
    expect(screen.getByText("Jane Doe")).toBeInTheDocument()
    expect(screen.getByText("Bob Ruiz")).toBeInTheDocument()
    expect(screen.getByText("72")).toBeInTheDocument()
    expect(screen.getByText("Failed")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "See CV for Jane Doe" }),
    ).toBeInTheDocument()
    // screening announcements live in a polite status region
    expect(document.querySelector('[aria-live="polite"]')).not.toBeNull()
  })

  it("keeps the header compact — full details live in Edit opening", () => {
    renderPage()
    expect(
      screen.getByRole("heading", { name: "Frontend Engineer" }),
    ).toBeInTheDocument()
    expect(screen.getByText("Open")).toBeInTheDocument()
    expect(
      screen.getByText(/Engineering · Berlin · Closes Oct 15, 2026/),
    ).toBeInTheDocument()
    expect(
      screen.queryByText("Build quiet interfaces."),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Details" }),
    ).not.toBeInTheDocument()
  })

  it("selects all, then bulk-shortlists via the floating bar", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(
      screen.getByRole("checkbox", { name: "Select all candidates" }),
    )
    expect(screen.getByText("2 selected")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Shortlist" }))
    expect(mocks.bulkSetDecision).toHaveBeenCalledWith(
      "o1",
      ["c1", "c2"],
      "shortlisted",
    )
    await waitFor(() =>
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument(),
    )
  })

  it("deletes a selected candidate through the confirm dialog", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole("checkbox", { name: "Select Jane Doe" }))
    await user.click(screen.getByRole("button", { name: "Delete" }))
    const dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByText("Delete 1 candidates?"),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "Delete" }))
    await waitFor(() =>
      expect(mocks.removeCandidate).toHaveBeenCalledWith("o1", "c1"),
    )
  })

  it("opens the review dialog from a needs_review cell and saves a verdict", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(
      screen.getByRole("button", {
        name: "Review Python — flagged for review",
      }),
    )
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("radio", { name: "Strong" }))
    await user.click(within(dialog).getByRole("button", { name: "Save review" }))
    await waitFor(() =>
      expect(mocks.reviewCriterion).toHaveBeenCalledWith(
        "o1",
        "c1",
        "python",
        { matchLevel: "strong", reviewNote: undefined },
      ),
    )
  })

  it("retries a failed, retryable candidate from the row", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole("button", { name: "Retry Bob Ruiz" }))
    expect(mocks.retryCandidate).toHaveBeenCalledWith("o1", "c2")
  })

  it("opens evidence from the row menu and jumps to the span's page", async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(
      screen.getByRole("button", { name: "Actions for Jane Doe" }),
    )
    await user.click(
      await screen.findByRole("menuitem", { name: /view evidence/i }),
    )
    const dialog = await screen.findByRole("dialog")
    await waitFor(() =>
      expect(within(dialog).getByText("Built internal Python tooling"))
        .toBeInTheDocument(),
    )
    await user.click(
      within(dialog).getByRole("button", { name: "Open CV at page 2" }),
    )
    expect(mocks.viewer.openCv).toHaveBeenCalledWith(
      expect.objectContaining({
        file: expect.objectContaining({ url: "/jane.pdf#page=2" }),
      }),
    )
  })

  it("navigates home once a viewed opening disappears from the store", async () => {
    const utils = renderPage()
    mocks.openings = []
    utils.rerender(
      <TooltipProvider>
        <MemoryRouter initialEntries={["/openings/o1"]}>
          <Routes>
            <Route path="/openings/:id" element={<OpeningDetailPage />} />
            <Route path="/" element={<div>home-route</div>} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>,
    )
    expect(await screen.findByText("home-route")).toBeInTheDocument()
  })

  it("holds the not-found panel until openings finish loading", async () => {
    mocks.openingsStatus = "loading"
    mocks.openings = []
    const utils = renderPage()
    expect(screen.queryByText("Opening not found")).not.toBeInTheDocument()

    mocks.openingsStatus = "ready"
    utils.rerender(
      <TooltipProvider>
        <MemoryRouter initialEntries={["/openings/o1"]}>
          <Routes>
            <Route path="/openings/:id" element={<OpeningDetailPage />} />
            <Route path="/" element={<div>home-route</div>} />
          </Routes>
        </MemoryRouter>
      </TooltipProvider>,
    )
    expect(await screen.findByText("Opening not found")).toBeInTheDocument()
  })
})

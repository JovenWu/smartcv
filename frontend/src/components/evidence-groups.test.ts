import { describe, expect, it } from "vitest"

import { groupEvidenceSpans } from "@/components/evidence-groups"
import type { Candidate, Criterion, EvidenceSpan } from "@/types"

const CRITERIA: Criterion[] = [
  { id: "python", name: "Python", description: "", weight: 4 },
  { id: "react", name: "React", description: "", weight: 3 },
]

const span = (id: string, page = 1): EvidenceSpan => ({
  id,
  pageNumber: page,
  text: `excerpt ${id}`,
})

const candidateWithEvals = (
  evaluations: Candidate["evaluations"],
): Candidate => ({
  id: "c1",
  openingId: "o1",
  name: "Jane Doe",
  file: { filename: "jane.pdf", url: "/jane.pdf", mimeType: "application/pdf" },
  status: "complete",
  uploadOrder: 0,
  uploadedAt: "2026-09-29T00:00:00Z",
  evaluations,
  totalScore: 80,
  isFinal: true,
  decision: "undecided",
  retryable: false,
})

describe("groupEvidenceSpans", () => {
  it("groups spans under their criterion in opening order", () => {
    const candidate = candidateWithEvals([
      {
        criterionId: "python",
        status: "strong",
        confidence: 0.9,
        modelFraction: 1,
        evidenceSpanIds: ["s1", "s2"],
      },
      {
        criterionId: "react",
        status: "partial",
        confidence: 0.6,
        modelFraction: 0.5,
        evidenceSpanIds: ["s3"],
      },
    ])
    const groups = groupEvidenceSpans(
      candidate,
      CRITERIA,
      [span("s1"), span("s2", 2), span("s3")],
    )
    expect(groups.map((g) => g.criterion?.id)).toEqual(["python", "react"])
    expect(groups[0].spans.map((s) => s.id)).toEqual(["s1", "s2"])
    expect(groups[0].evaluation?.status).toBe("strong")
  })

  it("lands spans referenced by no evaluation in a trailing group", () => {
    const candidate = candidateWithEvals([
      {
        criterionId: "python",
        status: "strong",
        confidence: 0.9,
        modelFraction: 1,
        evidenceSpanIds: ["s1"],
      },
    ])
    const groups = groupEvidenceSpans(candidate, CRITERIA, [
      span("s1"),
      span("s9"),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[1].criterion).toBeNull()
    expect(groups[1].spans.map((s) => s.id)).toEqual(["s9"])
  })

  it("skips evaluations whose spans were never stored", () => {
    const candidate = candidateWithEvals([
      {
        criterionId: "python",
        status: "not_found",
        confidence: 0.8,
        modelFraction: 0,
        evidenceSpanIds: ["missing"],
      },
    ])
    expect(groupEvidenceSpans(candidate, CRITERIA, [])).toEqual([])
  })
})

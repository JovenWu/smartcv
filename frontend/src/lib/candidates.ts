import { useMemo, useSyncExternalStore } from "react"

import { adjustCandidateCount } from "@/lib/openings"
import type { Candidate } from "@/types"

let candidates: Candidate[] = [
  // senior-frontend-engineer
  {
    id: "amara-chen",
    openingId: "senior-frontend-engineer",
    name: "Amara Chen",
    email: "amara.chen@example.com",
    file: {
      filename: "amara-chen-cv.pdf",
      url: "#",
      mimeType: "application/pdf",
      pageCount: 2,
    },
    status: "complete",
    uploadOrder: 0,
    uploadedAt: "2026-09-27T09:12:00Z",
    evaluations: [
      {
        criterionId: "react-experience",
        status: "strong",
        confidence: 0.92,
        modelFraction: 0.95,
        evidenceSpanIds: [],
      },
      {
        criterionId: "typescript-fluency",
        status: "strong",
        confidence: 0.88,
        modelFraction: 0.9,
        evidenceSpanIds: [],
      },
      {
        criterionId: "design-systems",
        status: "partial",
        confidence: 0.55,
        modelFraction: 0.5,
        evidenceSpanIds: [],
        rationale:
          "Contributed to a component library but did not own it.",
      },
    ],
    totalScore: 88,
    isFinal: true,
    decision: "undecided",
    retryable: false,
  },
  {
    id: "jonas-weber",
    openingId: "senior-frontend-engineer",
    name: "Jonas Weber",
    email: "j.weber@example.com",
    file: {
      filename: "jonas-weber.pdf",
      url: "#",
      mimeType: "application/pdf",
      pageCount: 3,
    },
    status: "complete",
    uploadOrder: 1,
    uploadedAt: "2026-09-27T09:13:00Z",
    evaluations: [
      {
        criterionId: "react-experience",
        status: "partial",
        confidence: 0.7,
        modelFraction: 0.6,
        evidenceSpanIds: [],
      },
      {
        criterionId: "typescript-fluency",
        status: "strong",
        confidence: 0.84,
        modelFraction: 0.85,
        evidenceSpanIds: [],
      },
      {
        criterionId: "design-systems",
        status: "not_found",
        confidence: 0.9,
        modelFraction: 0,
        evidenceSpanIds: [],
      },
    ],
    totalScore: 61,
    isFinal: true,
    decision: "undecided",
    retryable: false,
  },
  {
    id: "priya-nair",
    openingId: "senior-frontend-engineer",
    name: "Priya Nair",
    file: {
      filename: "priya-nair-resume.pdf",
      url: "#",
      mimeType: "application/pdf",
      pageCount: 2,
    },
    status: "needs_review",
    uploadOrder: 2,
    uploadedAt: "2026-09-27T09:14:00Z",
    evaluations: [
      {
        criterionId: "react-experience",
        status: "strong",
        confidence: 0.91,
        modelFraction: 0.9,
        evidenceSpanIds: [],
      },
      {
        criterionId: "typescript-fluency",
        status: "needs_review",
        confidence: 0.38,
        modelFraction: 0.4,
        evidenceSpanIds: [],
        rationale: "Conflicting claims about TypeScript usage.",
      },
      {
        criterionId: "design-systems",
        status: "partial",
        confidence: 0.66,
        modelFraction: 0.6,
        evidenceSpanIds: [],
      },
    ],
    totalScore: 71,
    isFinal: false,
    decision: "undecided",
    retryable: false,
  },
  {
    id: "marco-silva",
    openingId: "senior-frontend-engineer",
    name: "Marco Silva",
    file: {
      filename: "marco-silva-cv.pdf",
      url: "#",
      mimeType: "application/pdf",
      pageCount: 1,
    },
    status: "evaluating",
    uploadOrder: 3,
    uploadedAt: "2026-09-27T09:20:00Z",
    evaluations: [],
    totalScore: null,
    isFinal: false,
    decision: "undecided",
    retryable: false,
  },
  {
    id: "zoe-okafor",
    openingId: "senior-frontend-engineer",
    name: "Zoe Okafor",
    file: {
      filename: "zoe-okafor.pdf",
      url: "#",
      mimeType: "application/pdf",
      pageCount: 4,
    },
    status: "failed",
    uploadOrder: 4,
    uploadedAt: "2026-09-27T09:21:00Z",
    evaluations: [],
    totalScore: null,
    isFinal: false,
    decision: "undecided",
    errorMessage: "Scanned document; no extractable text.",
    retryable: true,
  },

  // backend-engineer
  {
    id: "sofia-rossi",
    openingId: "backend-engineer",
    name: "Sofia Rossi",
    email: "sofia.rossi@example.com",
    file: {
      filename: "sofia-rossi.pdf",
      url: "#",
      mimeType: "application/pdf",
      pageCount: 2,
    },
    status: "complete",
    uploadOrder: 0,
    uploadedAt: "2026-09-28T11:02:00Z",
    evaluations: [
      {
        criterionId: "api-design",
        status: "strong",
        confidence: 0.9,
        modelFraction: 0.9,
        evidenceSpanIds: [],
      },
      {
        criterionId: "python",
        status: "partial",
        confidence: 0.6,
        modelFraction: 0.5,
        evidenceSpanIds: [],
      },
    ],
    totalScore: 74,
    isFinal: true,
    decision: "shortlisted",
    retryable: false,
  },
  {
    id: "liam-novak",
    openingId: "backend-engineer",
    name: "Liam Novak",
    file: {
      filename: "liam-novak.pdf",
      url: "#",
      mimeType: "application/pdf",
      pageCount: 2,
    },
    status: "complete",
    uploadOrder: 1,
    uploadedAt: "2026-09-28T11:04:00Z",
    evaluations: [
      {
        criterionId: "api-design",
        status: "partial",
        confidence: 0.72,
        modelFraction: 0.6,
        evidenceSpanIds: [],
      },
      {
        criterionId: "python",
        status: "partial",
        confidence: 0.68,
        modelFraction: 0.55,
        evidenceSpanIds: [],
      },
    ],
    totalScore: 57,
    isFinal: true,
    decision: "undecided",
    retryable: false,
  },
  {
    id: "nina-petrova",
    openingId: "backend-engineer",
    name: "Nina Petrova",
    file: {
      filename: "nina-petrova.pdf",
      url: "#",
      mimeType: "application/pdf",
      pageCount: 3,
    },
    status: "needs_review",
    uploadOrder: 2,
    uploadedAt: "2026-09-28T11:09:00Z",
    evaluations: [
      {
        criterionId: "api-design",
        status: "needs_review",
        confidence: 0.41,
        modelFraction: 0.5,
        evidenceSpanIds: [],
      },
      {
        criterionId: "python",
        status: "strong",
        confidence: 0.87,
        modelFraction: 0.85,
        evidenceSpanIds: [],
      },
    ],
    totalScore: 66,
    isFinal: false,
    decision: "undecided",
    retryable: false,
  },

  // product-designer
  {
    id: "yuki-tanaka",
    openingId: "product-designer",
    name: "Yuki Tanaka",
    email: "yuki.t@example.com",
    file: {
      filename: "yuki-tanaka.pdf",
      url: "#",
      mimeType: "application/pdf",
      pageCount: 1,
    },
    status: "complete",
    uploadOrder: 0,
    uploadedAt: "2026-09-28T13:31:00Z",
    evaluations: [
      {
        criterionId: "portfolio",
        status: "strong",
        confidence: 0.93,
        modelFraction: 0.95,
        evidenceSpanIds: [],
      },
    ],
    totalScore: 92,
    isFinal: true,
    decision: "shortlisted",
    retryable: false,
  },
  {
    id: "elias-berg",
    openingId: "product-designer",
    name: "Elias Berg",
    file: {
      filename: "elias-berg.pdf",
      url: "#",
      mimeType: "application/pdf",
      pageCount: 2,
    },
    status: "complete",
    uploadOrder: 1,
    uploadedAt: "2026-09-28T13:33:00Z",
    evaluations: [
      {
        criterionId: "portfolio",
        status: "partial",
        confidence: 0.7,
        modelFraction: 0.6,
        evidenceSpanIds: [],
      },
    ],
    totalScore: 58,
    isFinal: true,
    decision: "undecided",
    retryable: false,
  },
  {
    id: "hana-suzuki",
    openingId: "product-designer",
    name: "Hana Suzuki",
    file: {
      filename: "hana-suzuki.pdf",
      url: "#",
      mimeType: "application/pdf",
      pageCount: 2,
    },
    status: "needs_review",
    uploadOrder: 2,
    uploadedAt: "2026-09-28T13:36:00Z",
    evaluations: [
      {
        criterionId: "portfolio",
        status: "needs_review",
        confidence: 0.35,
        modelFraction: 0.5,
        evidenceSpanIds: [],
      },
    ],
    totalScore: 64,
    isFinal: false,
    decision: "undecided",
    retryable: false,
  },
  {
    id: "omar-farouk",
    openingId: "product-designer",
    name: "Omar Farouk",
    file: {
      filename: "omar-farouk.pdf",
      url: "#",
      mimeType: "application/pdf",
      pageCount: 3,
    },
    status: "queued",
    uploadOrder: 3,
    uploadedAt: "2026-09-28T13:40:00Z",
    evaluations: [],
    totalScore: null,
    isFinal: false,
    decision: "undecided",
    retryable: false,
  },

  // engineering-manager (no criteria yet)
  {
    id: "ines-duarte",
    openingId: "engineering-manager",
    name: "Ines Duarte",
    file: {
      filename: "ines-duarte.pdf",
      url: "#",
      mimeType: "application/pdf",
      pageCount: 2,
    },
    status: "complete",
    uploadOrder: 0,
    uploadedAt: "2026-09-28T15:10:00Z",
    evaluations: [],
    totalScore: null,
    isFinal: true,
    decision: "undecided",
    retryable: false,
  },
  {
    id: "tomas-silva",
    openingId: "engineering-manager",
    name: "Tomas Silva",
    file: {
      filename: "tomas-silva.pdf",
      url: "#",
      mimeType: "application/pdf",
      pageCount: 2,
    },
    status: "extracting",
    uploadOrder: 1,
    uploadedAt: "2026-09-28T15:12:00Z",
    evaluations: [],
    totalScore: null,
    isFinal: false,
    decision: "undecided",
    retryable: false,
  },
]

const listeners = new Set<() => void>()

function subscribe(callback: () => void) {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

export function useCandidates(openingId: string | undefined): Candidate[] {
  const all = useSyncExternalStore(subscribe, () => candidates)
  return useMemo(
    () =>
      all
        .filter((c) => c.openingId === openingId)
        .sort((a, b) => a.uploadOrder - b.uploadOrder),
    [all, openingId],
  )
}

/** "jane-doe-cv.pdf" → "Jane Doe". */
function nameFromFile(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "")
  const name = stem
    .split(/[-_.\s]+/)
    .filter((w) => !["cv", "resume", "curriculum", "vitae"].includes(w.toLowerCase()))
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
  return name || stem || "Candidate"
}

export function addCandidates(openingId: string, files: File[]) {
  const nextOrder =
    candidates
      .filter((c) => c.openingId === openingId)
      .reduce((max, c) => Math.max(max, c.uploadOrder), -1) + 1

  const added: Candidate[] = files.map((file, i) => ({
    id: crypto.randomUUID(),
    openingId,
    name: nameFromFile(file.name),
    file: {
      filename: file.name,
      url: URL.createObjectURL(file),
      mimeType: file.type || "application/octet-stream",
    },
    status: "queued",
    uploadOrder: nextOrder + i,
    uploadedAt: new Date().toISOString(),
    evaluations: [],
    totalScore: null,
    isFinal: false,
    decision: "undecided",
    retryable: false,
  }))
  if (!added.length) return

  candidates = [...candidates, ...added]
  adjustCandidateCount(openingId, added.length)
  listeners.forEach((l) => l())
}

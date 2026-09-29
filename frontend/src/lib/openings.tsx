import { useSyncExternalStore, type ReactNode } from "react"

import {
  BriefcaseIcon,
  ChartColumnIcon,
  CodeIcon,
  PenToolIcon,
  ServerIcon,
  UsersIcon,
} from "lucide-react"

import type {
  EmploymentType,
  Opening as OpeningModel,
  WorkArrangement,
} from "@/types"

/** Domain opening plus view-only fields used by the sidebar and cards. */
export interface Opening extends OpeningModel {
  url: string
  icon?: ReactNode
}

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  full_time: "Full-time",
  part_time: "Part-time",
  contract: "Contract",
  internship: "Internship",
  casual: "Casual",
}

export const WORK_ARRANGEMENT_LABELS: Record<WorkArrangement, string> = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On-site",
}

/** One-line meta: "Engineering · Berlin · Hybrid · Full-time". */
export function openingMeta(
  opening: Pick<
    OpeningModel,
    "department" | "location" | "workArrangement" | "employmentType"
  >,
): string {
  return [
    opening.department,
    opening.location,
    opening.workArrangement && WORK_ARRANGEMENT_LABELS[opening.workArrangement],
    opening.employmentType && EMPLOYMENT_TYPE_LABELS[opening.employmentType],
  ]
    .filter(Boolean)
    .join(" · ")
}

export interface NewCriterionInput {
  name: string
  weight: number
  required?: boolean
}

export interface NewOpeningInput {
  title: string
  department?: string
  location?: string
  description?: string
  employmentType?: EmploymentType
  workArrangement?: WorkArrangement
  experienceLevel?: string
  educationLevel?: string
  skills?: string[]
  closesAt?: string
  icon?: ReactNode
  criteria?: NewCriterionInput[]
}

const seed: Array<Omit<Opening, "url">> = [
  {
    id: "senior-frontend-engineer",
    title: "Senior Frontend Engineer",
    icon: <CodeIcon />,
    department: "Engineering",
    location: "",
    description:
      "Owns the web client end to end: component architecture, state, performance.",
    employmentType: "full_time",
    workArrangement: "remote",
    experienceLevel: "5+ years",
    educationLevel: "Bachelor's degree or equivalent",
    skills: ["React", "TypeScript", "Design systems"],
    closesAt: "2026-10-15",
    source: { type: "manual" },
    status: "open",
    criteria: [
      {
        id: "react-experience",
        name: "React experience",
        description: "3+ years building production React apps.",
        weight: 5,
        required: true,
      },
      {
        id: "typescript-fluency",
        name: "TypeScript fluency",
        description: "Types non-trivial state and API contracts correctly.",
        weight: 4,
      },
      {
        id: "design-systems",
        name: "Design systems",
        description: "Has built or maintained a shared component library.",
        weight: 2,
        suggestedWeight: 3,
        suggestionConfidence: 0.6,
      },
    ],
    createdAt: "2026-09-21T09:00:00Z",
    candidates: 5,
    pendingReview: 1,
  },
  {
    id: "backend-engineer",
    title: "Backend Engineer",
    icon: <ServerIcon />,
    department: "Engineering",
    location: "Berlin",
    description:
      "APIs and data pipelines behind the screening workflow.",
    employmentType: "full_time",
    workArrangement: "hybrid",
    experienceLevel: "3+ years",
    skills: ["Python", "FastAPI", "PostgreSQL"],
    source: { type: "manual" },
    status: "open",
    criteria: [
      {
        id: "api-design",
        name: "API design",
        description: "Has designed and shipped a public REST or RPC API.",
        weight: 4,
        required: true,
      },
      {
        id: "python",
        name: "Python",
        description: "Production Python, async experience a plus.",
        weight: 3,
      },
    ],
    createdAt: "2026-09-22T14:30:00Z",
    candidates: 3,
    pendingReview: 1,
  },
  {
    id: "product-designer",
    title: "Product Designer",
    icon: <PenToolIcon />,
    department: "Design",
    location: "",
    description: "Flows, prototypes, and UI craft for the screening surface.",
    employmentType: "contract",
    workArrangement: "remote",
    experienceLevel: "4+ years",
    skills: ["Figma", "Prototyping", "B2B UI"],
    source: {
      type: "link",
      url: "https://www.linkedin.com/jobs/view/example",
    },
    status: "open",
    criteria: [
      {
        id: "portfolio",
        name: "Relevant portfolio",
        description: "Shipped B2B or data-dense product UI.",
        weight: 5,
      },
    ],
    createdAt: "2026-09-24T10:15:00Z",
    candidates: 4,
    pendingReview: 1,
  },
  {
    id: "data-scientist",
    title: "Data Scientist",
    icon: <ChartColumnIcon />,
    department: "Data",
    location: "London",
    description: "Scoring methodology, evaluation harnesses, error analysis.",
    employmentType: "full_time",
    workArrangement: "onsite",
    experienceLevel: "2+ years",
    skills: ["Python", "Statistics", "ML evaluation"],
    source: { type: "manual" },
    status: "draft",
    criteria: [],
    createdAt: "2026-09-26T16:45:00Z",
    candidates: 0,
    pendingReview: 0,
  },
  {
    id: "engineering-manager",
    title: "Engineering Manager",
    icon: <UsersIcon />,
    department: "Engineering",
    location: "Berlin",
    description: "Leads the screening team; hiring and delivery ownership.",
    employmentType: "full_time",
    workArrangement: "hybrid",
    experienceLevel: "7+ years",
    skills: ["Leadership", "Hiring", "Delivery"],
    source: {
      type: "file",
      filename: "em-role.pdf",
    },
    status: "open",
    criteria: [],
    createdAt: "2026-09-27T08:20:00Z",
    candidates: 2,
    pendingReview: 0,
  },
]

let openings: Opening[] = seed.map((o) => ({
  ...o,
  url: `/openings/${o.id}`,
}))

const listeners = new Set<() => void>()

function subscribe(callback: () => void) {
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
  }
}

export function useOpenings(): Opening[] {
  return useSyncExternalStore(subscribe, () => openings)
}

export function getOpening(id: string | undefined): Opening | undefined {
  return openings.find((o) => o.id === id)
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "opening"
  )
}

function buildCriteria(input: NewOpeningInput["criteria"]) {
  const criterionIds = new Set<string>()
  return (input ?? [])
    .filter((c) => c.name.trim())
    .map((c) => {
      let criterionId = slugify(c.name)
      let i = 2
      while (criterionIds.has(criterionId)) criterionId = `${slugify(c.name)}-${i++}`
      criterionIds.add(criterionId)
      return {
        id: criterionId,
        name: c.name.trim(),
        description: "",
        weight: Math.min(5, Math.max(1, Math.round(c.weight))),
        required: c.required,
      }
    })
}

export function addOpening(input: NewOpeningInput): Opening {
  let id = slugify(input.title)
  let suffix = 2
  while (getOpening(id)) id = `${slugify(input.title)}-${suffix++}`

  const criteria = buildCriteria(input.criteria)

  const opening: Opening = {
    id,
    title: input.title.trim(),
    url: `/openings/${id}`,
    icon: input.icon ?? <BriefcaseIcon />,
    department: input.department?.trim() ?? "",
    location: input.location?.trim() ?? "",
    description: input.description?.trim() ?? "",
    employmentType: input.employmentType,
    workArrangement: input.workArrangement,
    experienceLevel: input.experienceLevel?.trim() || undefined,
    educationLevel: input.educationLevel?.trim() || undefined,
    skills: input.skills?.length ? input.skills : undefined,
    closesAt: input.closesAt,
    source: { type: "manual" },
    status: "open",
    criteria,
    createdAt: new Date().toISOString(),
    candidates: 0,
    pendingReview: 0,
  }
  openings = [...openings, opening]
  listeners.forEach((l) => l())
  return opening
}

export function adjustCandidateCount(openingId: string, delta: number) {
  openings = openings.map((o) =>
    o.id === openingId ? { ...o, candidates: o.candidates + delta } : o,
  )
  listeners.forEach((l) => l())
}

export function updateOpening(
  id: string,
  input: NewOpeningInput,
): Opening | undefined {
  const existing = getOpening(id)
  if (!existing) return undefined

  const updated: Opening = {
    ...existing,
    title: input.title.trim(),
    department: input.department?.trim() ?? "",
    location: input.location?.trim() ?? "",
    description: input.description?.trim() ?? "",
    employmentType: input.employmentType,
    workArrangement: input.workArrangement,
    experienceLevel: input.experienceLevel?.trim() || undefined,
    educationLevel: input.educationLevel?.trim() || undefined,
    skills: input.skills?.length ? input.skills : undefined,
    closesAt: input.closesAt,
    criteria: buildCriteria(input.criteria),
    updatedAt: new Date().toISOString(),
  }
  openings = openings.map((o) => (o.id === id ? updated : o))
  listeners.forEach((l) => l())
  return updated
}

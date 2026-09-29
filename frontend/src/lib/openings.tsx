import { useSyncExternalStore, type ReactNode } from "react"

import {
  BriefcaseIcon,
  ChartColumnIcon,
  CodeIcon,
  PenToolIcon,
  ServerIcon,
  UsersIcon,
} from "lucide-react"

import {
  openingsApi,
  type NewOpeningPayload,
  type SkillSuggestion,
} from "@/lib/api"
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
  description?: string
  weight?: number
  required?: boolean
  suggestedWeight?: number
  suggestionConfidence?: number
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
  /** Origin of the listing — set when saving an imported draft. */
  source?: NewOpeningPayload["source"]
  icon?: ReactNode
  criteria?: NewCriterionInput[]
}

// ---------- store ----------

let openings: Opening[] = []
let loaded = false
let inflight: Promise<void> | null = null

const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

function subscribe(callback: () => void) {
  listeners.add(callback)
  if (!loaded) void refreshOpenings()
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

function iconFor(opening: OpeningModel): ReactNode {
  const haystack = `${opening.title} ${opening.department}`.toLowerCase()
  if (haystack.includes("design")) return <PenToolIcon />
  if (haystack.includes("data") || haystack.includes("scientist"))
    return <ChartColumnIcon />
  if (haystack.includes("manag") || haystack.includes("lead"))
    return <UsersIcon />
  if (haystack.includes("backend") || haystack.includes("server"))
    return <ServerIcon />
  if (haystack.includes("engineer") || haystack.includes("develop"))
    return <CodeIcon />
  return <BriefcaseIcon />
}

function decorate(opening: OpeningModel): Opening {
  return {
    ...opening,
    url: `/openings/${opening.id}`,
    icon: iconFor(opening),
  }
}

export async function refreshOpenings(): Promise<void> {
  inflight ??= openingsApi
    .list()
    .then((list) => {
      openings = list.map(decorate)
      loaded = true
      emit()
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function slugify(title: string): string {
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
      while (criterionIds.has(criterionId))
        criterionId = `${slugify(c.name)}-${i++}`
      criterionIds.add(criterionId)
      const weight = c.weight ?? c.suggestedWeight ?? 3
      return {
        id: criterionId,
        name: c.name.trim(),
        description: c.description ?? "",
        weight: Math.min(5, Math.max(1, Math.round(weight))),
        required: c.required,
        suggestedWeight: c.suggestedWeight,
        suggestionConfidence: c.suggestionConfidence,
      }
    })
}

function toPayload(input: NewOpeningInput): NewOpeningPayload {
  return {
    title: input.title.trim(),
    department: input.department?.trim() || undefined,
    location: input.location?.trim() || undefined,
    description: input.description?.trim() || undefined,
    employmentType: input.employmentType,
    workArrangement: input.workArrangement,
    experienceLevel: input.experienceLevel?.trim() || undefined,
    educationLevel: input.educationLevel?.trim() || undefined,
    skills: input.skills?.length ? input.skills : undefined,
    closesAt: input.closesAt,
    source: input.source ?? { type: "manual" },
    criteria: buildCriteria(input.criteria),
  }
}

export async function addOpening(input: NewOpeningInput): Promise<Opening> {
  const created = await openingsApi.create(toPayload(input))
  await refreshOpenings()
  return decorate(created)
}

export async function updateOpening(
  id: string,
  input: NewOpeningInput,
): Promise<void> {
  await openingsApi.update(id, toPayload(input))
  await refreshOpenings()
}

// ---------- skill -> criteria suggestions ----------

/**
 * Merge Jev skill suggestions into the form's criteria list — appends new
 * criteria for skills that matched nothing, skipping names already present.
 */
export function mergeSuggestions(
  criteria: NewCriterionInput[],
  suggestions: SkillSuggestion[],
): NewCriterionInput[] {
  const names = new Set(
    criteria.map((c) => c.name.trim().toLowerCase()),
  )
  const additions = suggestions
    .filter((s) => s.matchedCriterionId == null && s.criterion != null)
    .filter((s) => !names.has(s.criterion!.name.trim().toLowerCase()))
    .map((s) => ({
      name: s.criterion!.name,
      description: s.criterion!.description,
      weight: s.criterion!.suggestedWeight,
      required: s.criterion!.required,
      suggestedWeight: s.criterion!.suggestedWeight,
      suggestionConfidence: s.criterion!.confidence,
    }))
  return additions.length ? [...criteria, ...additions] : criteria
}

/** Test hook — clears the cache between tests. */
export function __resetOpeningsForTests() {
  openings = []
  loaded = false
  inflight = null
}

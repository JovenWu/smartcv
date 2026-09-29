import { useEffect, useRef, useState } from "react"
import { LoaderCircleIcon, PlusIcon, XIcon } from "lucide-react"

import { openingsApi } from "@/lib/api"
import {
  addOpening,
  EMPLOYMENT_TYPE_LABELS,
  mergeSuggestions,
  slugify,
  WORK_ARRANGEMENT_LABELS,
  type NewCriterionInput,
  type NewOpeningInput,
} from "@/lib/openings"
import type { EmploymentType, WorkArrangement } from "@/types"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

export function ManualOpeningForm({
  onDone,
  initial,
  onSubmit = addOpening,
  submitLabel = "Create opening",
}: {
  onDone: () => void
  /** Pre-filled draft, e.g. fields extracted from an imported listing. */
  initial?: Partial<NewOpeningInput>
  /** Where the entered data goes — addOpening by default, updateOpening when editing. */
  onSubmit?: (input: NewOpeningInput) => void | Promise<unknown>
  submitLabel?: string
}) {
  const [title, setTitle] = useState(initial?.title ?? "")
  const [department, setDepartment] = useState(initial?.department ?? "")
  const [location, setLocation] = useState(initial?.location ?? "")
  const [employmentType, setEmploymentType] = useState<
    EmploymentType | undefined
  >(initial?.employmentType)
  const [workArrangement, setWorkArrangement] = useState<
    WorkArrangement | undefined
  >(initial?.workArrangement)
  const [experienceLevel, setExperienceLevel] = useState(
    initial?.experienceLevel ?? "",
  )
  const [educationLevel, setEducationLevel] = useState(
    initial?.educationLevel ?? "",
  )
  const [closesAt, setClosesAt] = useState(initial?.closesAt ?? "")
  const [skills, setSkills] = useState(initial?.skills?.join(", ") ?? "")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [criteria, setCriteria] = useState<NewCriterionInput[]>(
    initial?.criteria ?? [],
  )
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const setCriterion = (index: number, patch: Partial<NewCriterionInput>) =>
    setCriteria((prev) =>
      prev.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    )

  // Debounced Jev classification: pause typing 600ms → classify new skills
  // against the filled role context and append suggested criteria.
  const suggestedRef = useRef<Set<string>>(
    new Set(
      [
        ...(initial?.skills ?? []),
        ...(initial?.criteria ?? []).map((c) => c.name),
      ].map((s) => s.trim().toLowerCase()),
    ),
  )
  const skillsRef = useRef(skills)
  skillsRef.current = skills
  const criteriaRef = useRef(criteria)
  criteriaRef.current = criteria

  useEffect(() => {
    const parsed = skills
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    const pending = parsed.filter(
      (s) => !suggestedRef.current.has(s.toLowerCase()),
    )
    if (!pending.length) return
    const timer = setTimeout(() => {
      const stillPending = pending.filter(
        (s) => !suggestedRef.current.has(s.toLowerCase()),
      )
      stillPending.forEach((s) =>
        suggestedRef.current.add(s.toLowerCase()),
      )
      if (!stillPending.length) return
      openingsApi
        .suggestCriteria({
          title: title.trim() || undefined,
          department: department.trim() || undefined,
          location: location.trim() || undefined,
          employmentType,
          workArrangement,
          experienceLevel: experienceLevel.trim() || undefined,
          educationLevel: educationLevel.trim() || undefined,
          description: description.trim() || undefined,
          skills: stillPending,
          existingCriteria: criteriaRef.current
            .filter((c) => c.name.trim())
            .map((c) => ({
              id: slugify(c.name),
              name: c.name.trim(),
            })),
        })
        .then((response) => {
          const current = new Set(
            skillsRef.current
              .split(",")
              .map((s) => s.trim().toLowerCase())
              .filter(Boolean),
          )
          const fresh = response.suggestions.filter((s) =>
            current.has(s.skill.trim().toLowerCase()),
          )
          if (!fresh.length) return
          setCriteria((prev) => mergeSuggestions(prev, fresh))
        })
        .catch(() => {
          // Suggestions are best-effort — typing must never block on Jev.
        })
    }, 600)
    return () => clearTimeout(timer)
    // Suggestion context is read from refs so a paused keystroke fires once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skills])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!title.trim() || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      await onSubmit({
        title,
        department,
        location,
        description,
        employmentType,
        workArrangement,
        experienceLevel,
        educationLevel,
        skills: skills
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        closesAt: closesAt || undefined,
        source: initial?.source,
        criteria,
      })
      onDone()
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "Could not save the opening.",
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="opening-title">Role title</FieldLabel>
          <Input
            id="opening-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            required
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field>
            <FieldLabel htmlFor="opening-department">Department</FieldLabel>
            <Input
              id="opening-department"
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="opening-location">Location</FieldLabel>
            <Input
              id="opening-location"
              placeholder="City, or leave blank if remote"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="opening-employment-type">
              Employment type
            </FieldLabel>
            <Select
              value={employmentType ?? ""}
              onValueChange={(v) => setEmploymentType(v as EmploymentType)}
            >
              <SelectTrigger id="opening-employment-type" className="w-full">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(EMPLOYMENT_TYPE_LABELS).map(
                  ([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="opening-work-arrangement">
              Work arrangement
            </FieldLabel>
            <Select
              value={workArrangement ?? ""}
              onValueChange={(v) => setWorkArrangement(v as WorkArrangement)}
            >
              <SelectTrigger id="opening-work-arrangement" className="w-full">
                <SelectValue placeholder="Select arrangement" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(WORK_ARRANGEMENT_LABELS).map(
                  ([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field>
            <FieldLabel htmlFor="opening-experience">Experience</FieldLabel>
            <Input
              id="opening-experience"
              placeholder="e.g. 3+ years"
              value={experienceLevel}
              onChange={(e) => setExperienceLevel(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="opening-education">Education</FieldLabel>
            <Input
              id="opening-education"
              placeholder="e.g. Bachelor's degree"
              value={educationLevel}
              onChange={(e) => setEducationLevel(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="opening-closes-at">Closes on</FieldLabel>
            <Input
              id="opening-closes-at"
              type="date"
              value={closesAt}
              onChange={(e) => setClosesAt(e.target.value)}
            />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="opening-skills">Skills</FieldLabel>
          <Input
            id="opening-skills"
            placeholder="React, TypeScript, GraphQL"
            value={skills}
            onChange={(e) => setSkills(e.target.value)}
          />
          <FieldDescription>
            Comma-separated — used to suggest criteria later.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="opening-description">Description</FieldLabel>
          <Textarea
            id="opening-description"
            placeholder="Responsibilities, context, seniority — the text the screener reads."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
          />
        </Field>

        <Field>
          <FieldLabel>Criteria</FieldLabel>
          <FieldDescription>
            What the screener checks in each CV, with weight 1–5.
          </FieldDescription>
          <div className="flex flex-col gap-2">
            {criteria.map((criterion, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  placeholder="e.g. React experience"
                  value={criterion.name}
                  onChange={(e) => setCriterion(i, { name: e.target.value })}
                  className="min-w-0 flex-1"
                />
                <Select
                  value={String(criterion.weight)}
                  onValueChange={(v) => setCriterion(i, { weight: Number(v) })}
                >
                  <SelectTrigger
                    className="w-16 shrink-0"
                    aria-label={`Weight for criterion ${i + 1}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5].map((w) => (
                      <SelectItem key={w} value={String(w)}>
                        {w}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox
                    checked={criterion.required ?? false}
                    onCheckedChange={(v) =>
                      setCriterion(i, { required: v === true })
                    }
                    aria-label={`Required criterion ${i + 1}`}
                  />
                  Required
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
                  onClick={() =>
                    setCriteria((prev) => prev.filter((_, j) => j !== i))
                  }
                  aria-label={`Remove criterion ${i + 1}`}
                >
                  <XIcon />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() =>
                setCriteria((prev) => [...prev, { name: "", weight: 3 }])
              }
            >
              <PlusIcon />
              Add criterion
            </Button>
          </div>
        </Field>

        {submitError && (
          <p className="text-xs text-destructive">{submitError}</p>
        )}
        <Field>
          <Button type="submit" disabled={!title.trim() || submitting}>
            {submitting && <LoaderCircleIcon className="animate-spin" />}
            {submitLabel}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

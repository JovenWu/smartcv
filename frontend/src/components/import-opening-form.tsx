import { useState } from "react"
import { LoaderCircleIcon } from "lucide-react"

import {
  openingsApi,
  type ImportCriterion,
  type ImportDraft,
} from "@/lib/api"
import type { NewOpeningInput } from "@/lib/openings"
import { Button } from "@/components/ui/button"
import { FileDropzone } from "@/components/file-dropzone"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"

function toCriterion(c: ImportCriterion) {
  return {
    name: c.name,
    description: c.description,
    weight: c.weight ?? c.suggestedWeight ?? 3,
    required: c.required,
    suggestedWeight: c.suggestedWeight,
    suggestionConfidence: c.suggestionConfidence,
  }
}

function toInput(draft: ImportDraft): Partial<NewOpeningInput> {
  return {
    title: draft.title,
    department: draft.department,
    location: draft.location,
    description: draft.description,
    employmentType: draft.employmentType as NewOpeningInput["employmentType"],
    workArrangement: draft.workArrangement as NewOpeningInput["workArrangement"],
    experienceLevel: draft.experienceLevel ?? undefined,
    educationLevel: draft.educationLevel ?? undefined,
    skills: draft.skills,
    closesAt: draft.closesAt ?? undefined,
    source: draft.source,
    criteria: draft.criteria.map(toCriterion),
  }
}

export function ImportOpeningForm({
  onExtracted,
}: {
  onExtracted: (draft: Partial<NewOpeningInput>) => void
}) {
  const [link, setLink] = useState("")
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const run = async (call: Promise<ImportDraft>) => {
    setProcessing(true)
    setError(null)
    try {
      onExtracted(toInput(await call))
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not read the listing.",
      )
      setProcessing(false)
    }
  }

  const importLink = (event: React.FormEvent) => {
    event.preventDefault()
    if (!link.trim()) return
    void run(openingsApi.importLink(link.trim()))
  }

  const importFiles = (files: File[]) => {
    const file = files[0]
    if (!file) return
    setNote(
      files.length > 1
        ? "One listing per import — using the first file."
        : null,
    )
    void run(openingsApi.importFile(file))
  }

  if (processing) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
        <p className="text-sm font-medium">Reading the listing…</p>
        <p className="text-xs text-muted-foreground">
          Extracting role details and criteria.
        </p>
      </div>
    )
  }

  return (
    <div>
      <form onSubmit={importLink}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="opening-link">Listing link</FieldLabel>
            <Input
              id="opening-link"
              type="url"
              placeholder="https://www.jobstreet.co.id/…"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              autoFocus
            />
            <FieldDescription>
              Works with Jobstreet, LinkedIn, and similar job boards.
            </FieldDescription>
          </Field>
          <Field>
            <Button type="submit" disabled={!link.trim()}>
              Import from link
            </Button>
          </Field>
        </FieldGroup>
      </form>

      <div className="my-5 flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="text-xs text-muted-foreground">or</span>
        <Separator className="flex-1" />
      </div>

      <FileDropzone
        accept=".pdf,.docx,image/*"
        title="Drop a PDF, DOCX, or screenshot here"
        hint="or click to browse files"
        onFiles={importFiles}
      />
      {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  )
}

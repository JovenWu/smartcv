import { useEffect, useRef, useState } from "react"
import { LoaderCircleIcon } from "lucide-react"

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

function titleFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "")
    return `${host} listing`
  } catch {
    return "Imported listing"
  }
}

function titleFromFile(name: string): string {
  return name.replace(/\.[^.]+$/, "") || "Imported listing"
}

export function ImportOpeningForm({
  onExtracted,
}: {
  onExtracted: (draft: Partial<NewOpeningInput>) => void
}) {
  const [link, setLink] = useState("")
  const [processing, setProcessing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  // Simulated extraction — the backend parser will return real fields here.
  const extract = (draft: Partial<NewOpeningInput>) => {
    setProcessing(true)
    timer.current = setTimeout(() => onExtracted(draft), 900)
  }

  const importLink = (event: React.FormEvent) => {
    event.preventDefault()
    if (!link.trim()) return
    extract({ title: titleFromUrl(link.trim()) })
  }

  const importFiles = (files: File[]) => {
    const file = files[0]
    if (!file) return
    extract({ title: titleFromFile(file.name) })
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
        accept=".pdf,image/*"
        title="Drop a PDF or screenshot here"
        hint="or click to browse files"
        onFiles={importFiles}
      />
    </div>
  )
}

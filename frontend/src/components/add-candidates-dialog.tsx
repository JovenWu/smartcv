import { useState } from "react"

import { addCandidates } from "@/lib/candidates"
import { FileDropzone } from "@/components/file-dropzone"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export function AddCandidatesDialog({
  openingId,
  open,
  onOpenChange,
}: {
  openingId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [error, setError] = useState<string | null>(null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add CVs</DialogTitle>
          <DialogDescription>
            Drop a batch — each CV is read and screened against this
            opening's criteria.
          </DialogDescription>
        </DialogHeader>
        <FileDropzone
          multiple
          accept=".pdf,.docx"
          title="Drop CVs here"
          hint="PDF or DOCX · multiple files · or click to browse"
          onFiles={(files) => {
            setError(null)
            addCandidates(openingId, files)
              .then(() => onOpenChange(false))
              .catch((err) =>
                setError(
                  err instanceof Error
                    ? err.message
                    : "Could not upload the batch.",
                ),
              )
          }}
        />
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}

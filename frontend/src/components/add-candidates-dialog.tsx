import { useState } from "react"

import { addCandidates, duplicateNotice } from "@/lib/candidates"
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
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (next) {
          setError(null)
          setNotice(null)
        }
      }}
    >
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
          busy={busy}
          title={busy ? "Uploading…" : "Drop CVs here"}
          hint="PDF or DOCX · multiple files · or click to browse"
          onFiles={(files) => {
            setError(null)
            setNotice(null)
            setBusy(true)
            addCandidates(openingId, files)
              .then((result) => {
                const skipped = duplicateNotice(result)
                if (skipped) {
                  setNotice(skipped)
                } else {
                  onOpenChange(false)
                }
              })
              .catch((err) =>
                setError(
                  err instanceof Error
                    ? err.message
                    : "Could not upload the batch.",
                ),
              )
              .finally(() => setBusy(false))
          }}
        />
        {notice && (
          <p className="mt-2 text-xs text-muted-foreground">{notice}</p>
        )}
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  )
}

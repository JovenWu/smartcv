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
          accept=".pdf,image/*"
          title="Drop CVs here"
          hint="PDF or image · multiple files · or click to browse"
          onFiles={(files) => {
            addCandidates(openingId, files)
            onOpenChange(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

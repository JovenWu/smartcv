import { updateOpening, useOpenings } from "@/lib/openings"
import { ManualOpeningForm } from "@/components/manual-opening-form"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export function EditOpeningDialog({
  openingId,
  open,
  onOpenChange,
}: {
  openingId: string | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const opening = useOpenings().find((o) => o.id === openingId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit opening</DialogTitle>
          <DialogDescription>
            Update the role details and screening criteria.
          </DialogDescription>
        </DialogHeader>
        {opening && (
          <ManualOpeningForm
            key={opening.id}
            initial={opening}
            submitLabel="Save changes"
            onSubmit={(input) => updateOpening(opening.id, input)}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

import {
  CircleXIcon,
  LoaderCircleIcon,
  StarIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"

export function BulkActionsBar({
  count,
  busy,
  onShortlist,
  onReject,
  onDelete,
  onClear,
}: {
  count: number
  busy?: boolean
  onShortlist: () => void
  onReject: () => void
  onDelete: () => void
  onClear: () => void
}) {
  if (count === 0) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
      <div
        role="toolbar"
        aria-label="Bulk candidate actions"
        className="pointer-events-auto flex animate-in items-center gap-0.5 rounded-full border bg-popover py-1.5 pr-1.5 pl-3 shadow-md ring-1 ring-foreground/10 duration-150 fade-in slide-in-from-bottom-2"
      >
        <span className="pr-1 text-xs font-medium tabular-nums">
          {count} selected
        </span>
        <Separator
          orientation="vertical"
          className="mx-1 data-vertical:h-4"
        />
        {busy && (
          <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground" />
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={onShortlist}
        >
          <StarIcon />
          Shortlist
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onReject}>
          <CircleXIcon />
          Reject
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2Icon />
          Delete
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Clear selection"
          disabled={busy}
          onClick={onClear}
        >
          <XIcon />
        </Button>
      </div>
    </div>
  )
}

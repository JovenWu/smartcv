import { useState } from "react"
import {
  ArchiveIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  PencilIcon,
} from "lucide-react"

import { openingMeta, setOpeningStatus } from "@/lib/openings"
import type { Opening, OpeningStatus } from "@/types"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const STATUS_META: Record<
  string,
  { icon: typeof CircleIcon; label: string }
> = {
  draft: { icon: PencilIcon, label: "Draft" },
  open: { icon: CircleDotIcon, label: "Open" },
  closed: { icon: CircleCheckIcon, label: "Closed" },
  archived: { icon: ArchiveIcon, label: "Archived" },
}

const STATUS_ORDER: OpeningStatus[] = [
  "draft",
  "open",
  "closed",
  "archived",
]

function statusMeta(status: OpeningStatus) {
  return STATUS_META[status] ?? { icon: CircleIcon, label: status }
}

function formatClosesAt(closesAt: string): string {
  const date = new Date(`${closesAt.slice(0, 10)}T12:00:00`)
  if (Number.isNaN(date.getTime())) return closesAt
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

export function OpeningSummary({ opening }: { opening: Opening }) {
  const meta = statusMeta(opening.status)
  const StatusIcon = meta.icon
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const metaLine = [
    openingMeta(opening),
    opening.closesAt ? `Closes ${formatClosesAt(opening.closesAt)}` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  const choose = async (status: OpeningStatus) => {
    if (status === opening.status || pending) return
    setPending(true)
    setError(null)
    try {
      await setOpeningStatus(opening.id, status)
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not update the opening status.",
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="truncate text-sm font-medium">{opening.title}</h1>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Badge
              asChild
              variant="outline"
              className="cursor-pointer font-normal text-muted-foreground hover:bg-muted data-[state=open]:bg-muted"
            >
              <button
                type="button"
                disabled={pending}
                aria-label={`Opening status: ${meta.label}`}
              >
                <StatusIcon data-icon="inline-start" />
                {meta.label}
                <ChevronDownIcon data-icon="inline-end" />
              </button>
            </Badge>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={opening.status}
              onValueChange={(value) => void choose(value as OpeningStatus)}
            >
              {STATUS_ORDER.map((status) => {
                const item = statusMeta(status)
                const ItemIcon = item.icon
                return (
                  <DropdownMenuRadioItem key={status} value={status}>
                    <ItemIcon />
                    {item.label}
                  </DropdownMenuRadioItem>
                )
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {metaLine && (
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {metaLine}
          </p>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

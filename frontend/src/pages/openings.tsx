import { useState } from "react"
import { Link } from "react-router-dom"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowUpRightIcon,
  EllipsisIcon,
  FileSearchIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { NewOpeningDialog } from "@/components/new-opening-dialog"
import {
  openingMeta,
  refreshOpenings,
  removeOpening,
  setOpeningArchived,
  useOpenings,
  useOpeningsStatus,
  type Opening,
} from "@/lib/openings"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"

function SkeletonCard() {
  return (
    <Card className="flex h-full flex-col" aria-hidden>
      <CardHeader>
        <Skeleton className="size-10 rounded-lg" />
        <div className="space-y-2 pt-3">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </CardHeader>
      <CardContent className="mt-auto">
        <Skeleton className="h-1 w-full" />
        <Skeleton className="mt-2 h-3 w-24" />
      </CardContent>
    </Card>
  )
}

type CardAction = "archive" | "unarchive" | "delete"

function OpeningCard({
  opening,
  onAction,
}: {
  opening: Opening
  onAction: (opening: Opening, action: CardAction) => void
}) {
  const screened = opening.candidates - opening.pendingReview
  const progress =
    opening.candidates > 0 ? (screened / opening.candidates) * 100 : 0
  const archived = opening.status === "archived"

  return (
    <div className="relative h-full">
      <Link
        to={opening.url}
        className="block h-full rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Card className="flex h-full flex-col transition-colors hover:border-foreground/20 hover:bg-accent/30">
          <CardHeader>
            <div className="flex items-start justify-between">
              <div className="flex size-10 items-center justify-center rounded-lg border bg-muted text-muted-foreground [&>svg]:size-5">
                {opening.icon}
              </div>
              <div className="flex items-center gap-1">
                {opening.pendingReview > 0 && (
                  <span
                    className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground tabular-nums"
                    aria-label={`${opening.pendingReview} pending review`}
                  >
                    {opening.pendingReview}
                  </span>
                )}
                <span className="size-7" aria-hidden />
              </div>
            </div>
            <div className="pt-3">
              <CardTitle className="flex items-center gap-2 text-base">
                {opening.title}
                {archived && <Badge variant="secondary">Archived</Badge>}
              </CardTitle>
              <CardDescription>{openingMeta(opening)}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="mt-auto">
            <Progress
              value={progress}
              className="h-1"
              aria-label={`${screened} of ${opening.candidates} candidates screened`}
            />
            <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {opening.candidates > 0
                  ? `${screened} of ${opening.candidates} screened`
                  : "No candidates yet"}
              </span>
              {opening.pendingReview > 0 ? (
                <span className="font-medium text-foreground">
                  pending review
                </span>
              ) : opening.candidates > 0 ? (
                <span>all reviewed</span>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Actions for ${opening.title}`}
            className="absolute top-2.5 right-2.5 z-10"
          >
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link to={opening.url}>
              <ArrowUpRightIcon />
              Open
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              onAction(opening, archived ? "unarchive" : "archive")
            }
          >
            {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
            {archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => onAction(opening, "delete")}
          >
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

const CONFIRM_COPY: Record<
  CardAction,
  { title: string; label: string; description: (title: string) => string }
> = {
  archive: {
    title: "Archive opening?",
    label: "Archive",
    description: (title) =>
      `"${title}" leaves the default list. Its candidates and scores are kept — you can unarchive it any time.`,
  },
  unarchive: {
    title: "Unarchive opening?",
    label: "Unarchive",
    description: (title) => `"${title}" returns to the default list.`,
  },
  delete: {
    title: "Delete opening?",
    label: "Delete",
    description: (title) =>
      `"${title}" and all its candidates, scores, and evidence will be permanently removed. This cannot be undone.`,
  },
}

export default function OpeningsPage() {
  const openings = useOpenings()
  const status = useOpeningsStatus()
  const [newOpeningOpen, setNewOpeningOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [confirm, setConfirm] = useState<{
    opening: Opening
    action: CardAction
  } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const active = openings.filter((o) => o.status !== "archived")
  const archived = openings.filter((o) => o.status === "archived")

  const handleAction = (opening: Opening, action: CardAction) => {
    setConfirm({ opening, action })
    setConfirmOpen(true)
  }

  const confirmAction = async () => {
    if (!confirm) return
    if (confirm.action === "delete") {
      await removeOpening(confirm.opening.id)
    } else {
      await setOpeningArchived(
        confirm.opening.id,
        confirm.action === "archive",
      )
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 pt-1">
      {status === "loading" && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      )}
      {status === "error" && (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed">
          <div className="flex max-w-sm flex-col items-center gap-4 p-10 text-center">
            <div className="flex size-10 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
              <FileSearchIcon className="size-5" />
            </div>
            <div className="space-y-1">
              <h2 className="text-sm font-medium">
                Couldn&rsquo;t load openings
              </h2>
              <p className="text-sm text-pretty text-muted-foreground">
                The list could not be fetched. Check the backend is running
                and try again.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => refreshOpenings().catch(() => {})}
            >
              <RotateCcwIcon />
              Try again
            </Button>
          </div>
        </div>
      )}
      {status === "ready" && openings.length === 0 && (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed">
          <div className="flex max-w-sm flex-col items-center gap-4 p-10 text-center">
            <div className="flex size-10 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
              <FileSearchIcon className="size-5" />
            </div>
            <div className="space-y-1">
              <h2 className="text-sm font-medium">No openings yet</h2>
              <p className="text-sm text-pretty text-muted-foreground">
                Import a job listing or type the role details, then drop CVs
                to screen them against your criteria.
              </p>
            </div>
            <Button size="sm" onClick={() => setNewOpeningOpen(true)}>
              <PlusIcon />
              New opening
            </Button>
          </div>
        </div>
      )}
      {status === "ready" && openings.length > 0 && (
        <>
          {archived.length > 0 && (
            <div className="flex items-center justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived ? (
                  <ArchiveRestoreIcon />
                ) : (
                  <ArchiveIcon />
                )}
                {showArchived
                  ? "Hide archived"
                  : `Archived (${archived.length})`}
              </Button>
            </div>
          )}
          {active.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              All openings are archived.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {active.map((opening) => (
                <OpeningCard
                  key={opening.id}
                  opening={opening}
                  onAction={handleAction}
                />
              ))}
            </div>
          )}
          {showArchived && archived.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-xs font-medium text-muted-foreground">
                Archived
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {archived.map((opening) => (
                  <OpeningCard
                    key={opening.id}
                    opening={opening}
                    onAction={handleAction}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
      <NewOpeningDialog
        open={newOpeningOpen}
        onOpenChange={setNewOpeningOpen}
      />
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={confirm ? CONFIRM_COPY[confirm.action].title : ""}
        description={
          confirm
            ? CONFIRM_COPY[confirm.action].description(confirm.opening.title)
            : undefined
        }
        confirmLabel={confirm ? CONFIRM_COPY[confirm.action].label : "Confirm"}
        destructive={confirm?.action === "delete"}
        onConfirm={confirmAction}
      />
    </div>
  )
}

import { useState } from "react"
import { Link } from "react-router-dom"
import { FileSearchIcon, PlusIcon, RotateCcwIcon } from "lucide-react"

import { NewOpeningDialog } from "@/components/new-opening-dialog"
import {
  openingMeta,
  refreshOpenings,
  useOpenings,
  useOpeningsStatus,
} from "@/lib/openings"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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

export default function OpeningsPage() {
  const openings = useOpenings()
  const status = useOpeningsStatus()
  const [newOpeningOpen, setNewOpeningOpen] = useState(false)

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
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
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {openings.map((opening) => {
            const screened = opening.candidates - opening.pendingReview
            const progress =
              opening.candidates > 0
                ? (screened / opening.candidates) * 100
                : 0
            return (
              <Link
                key={opening.id}
                to={opening.url}
                className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Card className="flex h-full flex-col transition-colors hover:border-foreground/20 hover:bg-accent/30">
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="flex size-10 items-center justify-center rounded-lg border bg-muted text-muted-foreground [&>svg]:size-5">
                        {opening.icon}
                      </div>
                      {opening.pendingReview > 0 && (
                        <span
                          className="flex size-7 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background tabular-nums"
                          aria-label={`${opening.pendingReview} pending review`}
                        >
                          {opening.pendingReview}
                        </span>
                      )}
                    </div>
                    <div className="pt-3">
                      <CardTitle className="text-base">
                        {opening.title}
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
            )
          })}
        </div>
      )}
      <NewOpeningDialog
        open={newOpeningOpen}
        onOpenChange={setNewOpeningOpen}
      />
    </div>
  )
}

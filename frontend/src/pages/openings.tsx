import { Link } from "react-router-dom"

import { openingMeta, useOpenings } from "@/lib/openings"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"

export default function OpeningsPage() {
  const openings = useOpenings()

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
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
    </div>
  )
}

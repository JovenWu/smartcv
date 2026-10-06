import { useEffect, useState } from "react"
import { BookOpenIcon, RotateCcwIcon } from "lucide-react"

import { useCvViewer } from "@/components/cv-viewer-context"
import { groupEvidenceSpans } from "@/components/evidence-groups"
import { MATCH_META } from "@/components/match-meta"
import { candidatesApi } from "@/lib/api"
import type {
  Candidate,
  EvidenceSpan,
  Opening,
} from "@/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Lists a candidate's evidence excerpts grouped by criterion. Each excerpt
 * carries a page chip that opens the CV viewer deep-linked to that page.
 */
export function EvidenceDialog({
  opening,
  candidate,
  open,
  onOpenChange,
}: {
  opening: Opening
  candidate: Candidate | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { openCv } = useCvViewer()
  const candidateId = candidate?.id
  // Results are tagged with the candidate they belong to, so a target switch
  // never shows stale excerpts — no reset effect needed.
  const [result, setResult] = useState<{
    id: string
    spans: EvidenceSpan[]
  } | null>(null)
  const [failure, setFailure] = useState<{
    id: string
    message: string
  } | null>(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!open || !candidateId) return
    let cancelled = false
    candidatesApi
      .spans(opening.id, candidateId)
      .then((list) => {
        if (!cancelled) setResult({ id: candidateId, spans: list })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setFailure({
          id: candidateId,
          message:
            err instanceof Error
              ? err.message
              : "Could not load the evidence excerpts.",
        })
      })
    return () => {
      cancelled = true
    }
  }, [open, candidateId, opening.id, nonce])

  const spans =
    candidateId != null && result?.id === candidateId ? result.spans : null
  const error =
    candidateId != null && failure?.id === candidateId
      ? failure.message
      : null
  const loading = open && candidateId != null && spans === null && error === null

  const openAtPage = (page?: number) => {
    if (!candidate) return
    const url = candidate.file.url.split("#")[0]
    openCv(
      page != null
        ? {
            ...candidate,
            file: { ...candidate.file, url: `${url}#page=${page}` },
          }
        : candidate,
    )
    onOpenChange(false)
  }

  const groups =
    candidate && spans
      ? groupEvidenceSpans(candidate, opening.criteria, spans)
      : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            Evidence{candidate ? ` — ${candidate.name}` : ""}
          </DialogTitle>
          <DialogDescription>
            Verbatim excerpts from the CV backing each criterion's assessment.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && (
            <div className="flex flex-col gap-3 py-1" aria-busy="true">
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-3.5 w-1/4" />
              <Skeleton className="h-10 w-full" />
            </div>
          )}
          {!loading && error && (
            <div className="flex flex-col items-start gap-2 py-1">
              <p className="text-xs text-destructive">{error}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setFailure(null)
                  setNonce((n) => n + 1)
                }}
              >
                <RotateCcwIcon />
                Try again
              </Button>
            </div>
          )}
          {!loading && !error && spans && groups.length === 0 && (
            <p className="py-1 text-xs text-muted-foreground">
              No evidence excerpts were recorded for this candidate.
            </p>
          )}
          {!loading && !error && groups.length > 0 && (
            <div className="flex flex-col gap-4 py-1">
              {groups.map((group) => {
                const meta = group.evaluation
                  ? MATCH_META[group.evaluation.status]
                  : null
                return (
                  <section key={group.criterion?.id ?? "other"}>
                    <div className="flex items-center gap-2">
                      <h3 className="text-xs font-medium">
                        {group.criterion?.name ?? "Other excerpts"}
                      </h3>
                      {meta && (
                        <Badge
                          variant={meta.badgeVariant}
                          className={meta.badgeClass}
                        >
                          <meta.icon data-icon="inline-start" />
                          {meta.label}
                        </Badge>
                      )}
                    </div>
                    <ul className="mt-1.5 flex flex-col gap-2">
                      {group.spans.map((span) => (
                        <li
                          key={span.id}
                          className="flex items-start gap-2"
                        >
                          <blockquote className="min-w-0 flex-1 border-l-2 border-border pl-3 text-xs leading-5 text-foreground/90">
                            {span.text}
                          </blockquote>
                          <Button
                            variant="outline"
                            size="xs"
                            className="shrink-0 tabular-nums"
                            aria-label={`Open CV at page ${span.pageNumber}`}
                            title={`Open CV at page ${span.pageNumber}`}
                            onClick={() => openAtPage(span.pageNumber)}
                          >
                            p. {span.pageNumber}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )
              })}
            </div>
          )}
        </div>
        <DialogFooter showCloseButton>
          <Button
            variant="outline"
            size="sm"
            onClick={() => openAtPage()}
            disabled={!candidate}
          >
            <BookOpenIcon />
            Open CV
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

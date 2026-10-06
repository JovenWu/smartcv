import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useAutoAnimate } from "@formkit/auto-animate/react"
import { cn } from "cn"
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  EyeIcon,
  FileSearchIcon,
  FileUpIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
} from "lucide-react"
import { Link, useNavigate, useParams } from "react-router-dom"

import { AddCandidatesDialog } from "@/components/add-candidates-dialog"
import { BulkActionsBar } from "@/components/bulk-actions-bar"
import { CandidateRowMenu } from "@/components/candidate-row-menu"
import { useCvViewer } from "@/components/cv-viewer-context"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { DecisionMenu } from "@/components/decision-menu"
import { EvidenceDialog } from "@/components/evidence-dialog"
import { FileDropzone } from "@/components/file-dropzone"
import { MATCH_META } from "@/components/match-meta"
import { OpeningSummary } from "@/components/opening-summary"
import {
  ReviewDialog,
  type ReviewTarget,
} from "@/components/review-dialog"
import {
  addCandidates,
  bulkSetDecision,
  duplicateNotice,
  IN_FLIGHT_STATUSES,
  orderCandidates,
  removeCandidate,
  retryCandidate as retryCandidateApi,
  useCandidates,
  useCandidatesStatus,
  type CandidateSort,
} from "@/lib/candidates"
import {
  refreshOpenings,
  useOpenings,
  useOpeningsStatus,
} from "@/lib/openings"
import type {
  Candidate,
  CandidateDecision,
  CandidateStatus,
  CriterionEvaluation,
  Opening,
} from "@/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const STATUS_LABEL: Record<CandidateStatus, string> = {
  queued: "Queued",
  extracting: "Reading",
  evaluating: "Screening",
  complete: "Screened",
  needs_review: "Needs review",
  failed: "Failed",
}

const IN_FLIGHT = IN_FLIGHT_STATUSES

function MatchCell({
  evaluation,
  pending,
  criterionName,
  onReview,
}: {
  evaluation?: CriterionEvaluation
  pending?: boolean
  criterionName?: string
  /** When set, needs_review cells become a button opening the review dialog. */
  onReview?: () => void
}) {
  if (!evaluation) {
    return pending ? (
      <Skeleton className="h-3.5 w-20" />
    ) : (
      <span className="text-muted-foreground">—</span>
    )
  }
  const meta = MATCH_META[evaluation.status]
  const Icon = meta.icon
  const cell = (
    <Badge
      variant={meta.badgeVariant}
      className={cn(
        "animate-in fade-in duration-200",
        meta.badgeClass,
        evaluation.status === "needs_review" && "font-semibold",
      )}
    >
      <Icon data-icon="inline-start" />
      {meta.label}
    </Badge>
  )
  const reviewable = evaluation.status === "needs_review" && !!onReview
  const interactive = reviewable ? (
    <button
      type="button"
      onClick={onReview}
      aria-label={`Review ${criterionName ?? "criterion"} — flagged for review`}
      className="cursor-pointer rounded-sm underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {cell}
    </button>
  ) : (
    cell
  )
  if (!evaluation.rationale) return interactive
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {reviewable ? (
          interactive
        ) : (
          <span
            tabIndex={0}
            className="cursor-default rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {interactive}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent className="max-w-64 flex-col items-start gap-0.5">
        <p className="font-medium">
          {meta.label} · {Math.round(evaluation.confidence * 100)}% confident
        </p>
        <p className="break-words text-muted-foreground">
          {evaluation.rationale}
        </p>
      </TooltipContent>
    </Tooltip>
  )
}

function SortIcon({
  active,
  dir,
}: {
  active: boolean
  dir: "asc" | "desc"
}) {
  if (!active) {
    return (
      <ArrowUpDownIcon className="size-3 shrink-0 text-muted-foreground/60" />
    )
  }
  return dir === "asc" ? (
    <ArrowUpIcon className="size-3 shrink-0" />
  ) : (
    <ArrowDownIcon className="size-3 shrink-0" />
  )
}

function ScoreCell({ candidate }: { candidate: Candidate }) {
  if (candidate.totalScore != null) {
    return (
      <span className="animate-in font-medium tabular-nums fade-in duration-200">
        {candidate.totalScore}
      </span>
    )
  }
  if (IN_FLIGHT.has(candidate.status)) {
    return <Skeleton className="h-3.5 w-10" />
  }
  return (
    <Badge
      variant={
        candidate.status === "failed"
          ? "destructive"
          : candidate.status === "needs_review"
            ? "default"
            : "secondary"
      }
    >
      {STATUS_LABEL[candidate.status]}
    </Badge>
  )
}

const SKELETON_ROWS = Array.from({ length: 6 }, (_, i) => i)

/**
 * Table-shaped placeholder with the same chrome/geometry as the real
 * scorecard, so rows slide in without a layout jump. Criterion headers
 * are passed in when the opening is already loaded; otherwise generic
 * bars stand in for them.
 */
function ScorecardSkeleton({ columns }: { columns?: string[] }) {
  const cols = columns ?? ["", "", ""]
  return (
    <Table containerProps={{ "aria-hidden": true }}>
      <TableHeader>
        <TableRow>
          <TableHead className="sticky left-0 top-0 z-20 h-8 w-36 max-w-36 bg-background text-xs sm:w-44 sm:max-w-44">
            <div className="flex items-center gap-2">
              <Skeleton className="size-4 rounded-[4px]" />
              Candidate
            </div>
          </TableHead>
          {cols.map((column, i) => (
            <TableHead
              key={`${i}-${column}`}
              className="sticky top-0 z-10 h-8 max-w-36 bg-background text-xs font-normal"
            >
              {column ? (
                <span className="block truncate">{column}</span>
              ) : (
                <Skeleton className="h-3.5 w-16" />
              )}
            </TableHead>
          ))}
          <TableHead className="sticky right-0 top-0 z-20 h-8 bg-background text-right text-xs">
            Score
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="animate-pulse">
        {SKELETON_ROWS.map((row) => (
          <TableRow key={row}>
            <TableCell className="sticky left-0 z-10 max-w-36 bg-background px-2 py-1.5 sm:max-w-44">
              <div className="flex items-center gap-2">
                <Skeleton className="size-4 shrink-0 rounded-[4px]" />
                <div className="flex min-w-0 flex-col gap-1.5 py-0.5">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-2.5 w-20" />
                </div>
              </div>
            </TableCell>
            {cols.map((_, i) => (
              <TableCell key={i} className="px-2 py-1.5">
                <Skeleton className="h-3.5 w-14" />
              </TableCell>
            ))}
            <TableCell className="sticky right-0 z-10 bg-background px-2 py-1.5">
              <div className="flex items-center justify-end gap-0.5">
                <Skeleton className="h-3.5 w-8" />
                <Skeleton className="h-6 w-16 rounded-md" />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

/** Full-page wait: mirrors the delivered layout (summary, toolbar,
    scorecard) instead of a lone spinner. */
function OpeningSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading opening"
      className="flex min-h-0 flex-1 flex-col gap-4 p-4 pt-0"
    >
      <span className="sr-only">Loading opening…</span>
      <div className="flex items-center gap-2" aria-hidden>
        <div className="min-w-0 flex-1">
          <Skeleton className="h-4 w-56" />
          <Skeleton className="mt-1.5 h-3 w-44" />
        </div>
        <Skeleton className="h-7 w-16" />
      </div>
      <div className="flex items-center" aria-hidden>
        <Skeleton className="ml-auto h-8 w-24" />
      </div>
      <div className="min-h-0 flex-1" aria-hidden>
        <ScorecardSkeleton />
      </div>
    </div>
  )
}

function ErrorPanel({
  title,
  body,
  onRetry,
}: {
  title: string
  body: string
  onRetry: () => void
}) {
  return (
    <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed">
      <div className="flex max-w-sm flex-col items-center gap-4 p-10 text-center">
        <div className="flex size-10 items-center justify-center rounded-lg border bg-muted text-muted-foreground">
          <FileSearchIcon className="size-5" />
        </div>
        <div className="space-y-1">
          <h2 className="text-sm font-medium">{title}</h2>
          <p className="text-sm text-pretty text-muted-foreground">{body}</p>
        </div>
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCcwIcon />
          Try again
        </Button>
      </div>
    </div>
  )
}

function CandidatesSkeleton({ opening }: { opening: Opening }) {
  return (
    <div className="h-full" role="status">
      <span className="sr-only">Loading candidates…</span>
      <ScorecardSkeleton
        columns={opening.criteria.map((c) => c.name)}
      />
    </div>
  )
}

function CandidateSection({
  opening,
  onRetry,
}: {
  opening: Opening
  onRetry: () => void
}) {
  const candidates = useCandidates(opening.id)
  const candidatesStatus = useCandidatesStatus(opening.id)
  const { selected, openCv, closeCv } = useCvViewer()
  const [addOpen, setAddOpen] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadNotice, setUploadNotice] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [sort, setSort] = useState<CandidateSort>({
    column: "score",
    dir: "desc",
  })
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const [evidenceFor, setEvidenceFor] = useState<Candidate | null>(null)
  const [reviewFor, setReviewFor] = useState<ReviewTarget | null>(null)
  const [deleteFor, setDeleteFor] = useState<Candidate | null>(null)
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const prevStatuses = useRef(new Map<string, Candidate["status"]>())
  const liveRef = useRef<HTMLParagraphElement>(null)
  // Only the outer wrapper keeps auto-animate — animating <tr> elements
  // breaks the sticky pinned cells and repaints rows over the header.
  const [bodyRef] = useAutoAnimate<HTMLDivElement>({
    duration: 200,
    easing: "cubic-bezier(0.25, 1, 0.5, 1)",
  })

  const sorted = useMemo(
    () => orderCandidates(candidates, sort),
    [candidates, sort],
  )
  const inFlight = candidates.filter((c) =>
    IN_FLIGHT.has(c.status),
  ).length

  // The raw selection may hold ids of rows deleted meanwhile — the live
  // view intersects it with the current list, no pruning effect needed.
  const liveSelection = useMemo(() => {
    const alive = new Set(candidates.map((c) => c.id))
    return new Set([...selectedIds].filter((cid) => alive.has(cid)))
  }, [candidates, selectedIds])

  // Screen-reader narration: progress plus candidates that just finished.
  // Written imperatively — a live region's DOM text IS the target system.
  useEffect(() => {
    const prev = prevStatuses.current
    const justFinished: string[] = []
    const next = new Map<string, Candidate["status"]>()
    for (const candidate of candidates) {
      next.set(candidate.id, candidate.status)
      const before = prev.get(candidate.id)
      if (
        before !== undefined &&
        before !== candidate.status &&
        IN_FLIGHT.has(before) &&
        !IN_FLIGHT.has(candidate.status)
      ) {
        justFinished.push(
          `${candidate.name} — ${STATUS_LABEL[candidate.status].toLowerCase()}`,
        )
      }
    }
    prevStatuses.current = next
    const parts: string[] = []
    if (candidates.length > 0) {
      parts.push(
        inFlight > 0
          ? `Screening ${candidates.length - inFlight} of ${candidates.length}.`
          : "Screening complete.",
      )
    }
    parts.push(...justFinished)
    const node = liveRef.current
    if (node) node.textContent = parts.join(" ")
  }, [candidates, inFlight])

  const toggleSort = (column: string) =>
    setSort((prev) =>
      prev.column === column
        ? { column, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { column, dir: column === "name" ? "asc" : "desc" },
    )

  const ariaSort = (
    column: string,
  ): "ascending" | "descending" | undefined =>
    sort.column === column
      ? sort.dir === "asc"
        ? "ascending"
        : "descending"
      : undefined

  const message = (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback

  const toggleSelected = (candidateId: string, on: boolean) =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(candidateId)
      else next.delete(candidateId)
      return next
    })

  const allSelected =
    sorted.length > 0 && sorted.every((c) => liveSelection.has(c.id))
  const toggleAll = (on: boolean) =>
    setSelectedIds(on ? new Set(sorted.map((c) => c.id)) : new Set())

  const markPending = (candidateId: string, on: boolean) =>
    setPendingIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(candidateId)
      else next.delete(candidateId)
      return next
    })

  const retry = async (candidate: Candidate) => {
    if (pendingIds.has(candidate.id)) return
    markPending(candidate.id, true)
    setActionError(null)
    try {
      await retryCandidateApi(opening.id, candidate.id)
    } catch (error) {
      setActionError(
        message(error, "Could not requeue the candidate."),
      )
    } finally {
      markPending(candidate.id, false)
    }
  }

  // Runs inside ConfirmDialog — it awaits, keeps the dialog open on throw
  // and shows the error inline, and closes itself on success.
  const deleteCandidate = async (candidate: Candidate) => {
    setActionError(null)
    await removeCandidate(opening.id, candidate.id)
    if (selected?.id === candidate.id) closeCv()
    toggleSelected(candidate.id, false)
  }

  const openReview = (candidate: Candidate, criterionId: string) => {
    const criterion = opening.criteria.find((c) => c.id === criterionId)
    const evaluation = candidate.evaluations.find(
      (e) => e.criterionId === criterionId,
    )
    if (criterion && evaluation) {
      setReviewFor({ candidate, criterion, evaluation })
    }
  }

  const bulkDecide = async (decision: CandidateDecision) => {
    const ids = [...liveSelection]
    if (!ids.length || bulkBusy) return
    setBulkBusy(true)
    setActionError(null)
    try {
      await bulkSetDecision(opening.id, ids, decision)
      setSelectedIds(new Set())
    } catch (error) {
      setActionError(
        message(error, "Could not update the selected candidates."),
      )
    } finally {
      setBulkBusy(false)
    }
  }

  // ConfirmDialog awaits this — a throw keeps it open with the error shown.
  const bulkDelete = async () => {
    const ids = [...liveSelection]
    if (!ids.length || bulkBusy) return
    setBulkBusy(true)
    setActionError(null)
    try {
      const results = await Promise.allSettled(
        ids.map((cid) => removeCandidate(opening.id, cid)),
      )
      if (selected && ids.includes(selected.id)) closeCv()
      const failed = results.filter((r) => r.status === "rejected").length
      if (failed > 0) {
        throw new Error(
          `${failed} of ${ids.length} deletions failed — try again.`,
        )
      }
      setSelectedIds(new Set())
    } finally {
      setBulkBusy(false)
    }
  }

  const uploadFiles = (files: File[]) => {
    setUploadError(null)
    setUploadNotice(null)
    setUploading(true)
    addCandidates(opening.id, files)
      .then((result) => setUploadNotice(duplicateNotice(result)))
      .catch((err) =>
        setUploadError(
          message(err, "Could not upload the batch."),
        ),
      )
      .finally(() => setUploading(false))
  }

  return (
    <>
      <div className="flex items-center gap-2">
        {inFlight > 0 && (
          <p
            aria-hidden="true"
            className="animate-in text-xs text-muted-foreground fade-in duration-200"
          >
            Screening {candidates.length - inFlight} of {candidates.length}…
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => setAddOpen(true)}
        >
          <FileUpIcon />
          Add CVs
        </Button>
      </div>
      {uploadError && (
        <p className="text-xs text-destructive">{uploadError}</p>
      )}
      {uploadNotice && (
        <p className="animate-in text-xs text-muted-foreground fade-in duration-200">
          {uploadNotice}
        </p>
      )}
      {actionError && (
        <p className="text-xs text-destructive">{actionError}</p>
      )}
      {candidatesStatus === "error" && candidates.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Live updates paused — showing the last known scorecard.
        </p>
      )}
      <p ref={liveRef} role="status" aria-live="polite" className="sr-only" />

      <div className="relative min-h-0 min-w-0 flex-1" ref={bodyRef}>
        {candidates.length === 0 ? (
          candidatesStatus === "error" ? (
            <ErrorPanel
              title="Couldn't load candidates"
              body="The scorecard could not be fetched. Check the backend is running and try again."
              onRetry={onRetry}
            />
          ) : candidatesStatus === "ready" ? (
            <FileDropzone
              multiple
              accept=".pdf,.docx"
              busy={uploading}
              className="h-full justify-center"
              title={
                uploading ? "Uploading…" : "No candidates yet — drop CVs here"
              }
              hint="PDF or DOCX · multiple files · or click to browse a batch"
              onFiles={uploadFiles}
            />
          ) : (
            <CandidatesSkeleton opening={opening} />
          )
        ) : (
          <Table
            containerProps={{
              role: "region",
              tabIndex: 0,
              "aria-label": "Candidate scorecard",
            }}
          >
            <TableHeader>
              <TableRow>
                <TableHead
                  aria-sort={ariaSort("name")}
                  className="sticky left-0 top-0 z-20 h-8 w-36 max-w-36 bg-background text-xs sm:w-44 sm:max-w-44"
                >
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={
                        allSelected
                          ? true
                          : liveSelection.size > 0
                            ? "indeterminate"
                            : false
                      }
                      onCheckedChange={(v) => toggleAll(v === true)}
                      aria-label="Select all candidates"
                    />
                    <button
                      type="button"
                      onClick={() => toggleSort("name")}
                      className="inline-flex items-center gap-1 rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      Candidate
                      <SortIcon
                        active={sort.column === "name"}
                        dir={sort.dir}
                      />
                    </button>
                  </div>
                </TableHead>
                {opening.criteria.map((c) => (
                  <TableHead
                    key={c.id}
                    aria-sort={ariaSort(c.id)}
                    className="sticky top-0 z-10 h-8 max-w-36 bg-background text-xs"
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => toggleSort(c.id)}
                          className="flex w-full min-w-0 items-center gap-1 rounded-sm font-normal focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                        >
                          <span className="truncate">{c.name}</span>
                          <SortIcon
                            active={sort.column === c.id}
                            dir={sort.dir}
                          />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-64">
                        <p className="font-medium">{c.name}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TableHead>
                ))}
                <TableHead
                  aria-sort={ariaSort(
                    sort.column === "decision" ? "decision" : "score",
                  )}
                  className="sticky right-0 top-0 z-20 h-8 bg-background text-right text-xs"
                >
                  <div className="flex items-center justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => toggleSort("score")}
                      className="inline-flex items-center gap-1 rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      Score
                      <SortIcon
                        active={sort.column === "score"}
                        dir={sort.dir}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleSort("decision")}
                      className="inline-flex items-center gap-1 rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      Decision
                      <SortIcon
                        active={sort.column === "decision"}
                        dir={sort.dir}
                      />
                    </button>
                  </div>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((candidate) => (
                <TableRow
                  key={candidate.id}
                  data-state={
                    selected?.id === candidate.id ? "selected" : undefined
                  }
                  className="group"
                >
                  <TableCell className="sticky left-0 z-10 max-w-36 bg-background px-2 py-1.5 group-hover:bg-muted group-data-[state=selected]:bg-muted sm:max-w-44">
                    <div className="flex min-w-0 items-center gap-2">
                      <Checkbox
                        checked={liveSelection.has(candidate.id)}
                        onCheckedChange={(v) =>
                          toggleSelected(candidate.id, v === true)
                        }
                        aria-label={`Select ${candidate.name}`}
                      />
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div
                            tabIndex={0}
                            className="flex min-w-0 flex-1 flex-col rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                          >
                            <span className="truncate font-medium">
                              {candidate.name}
                            </span>
                            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                              <span
                                className={cn(
                                  "size-1.5 shrink-0 rounded-full",
                                  IN_FLIGHT.has(candidate.status)
                                    ? "animate-pulse bg-primary/60"
                                    : "invisible",
                                )}
                              />
                              <span className="truncate">
                                {candidate.status === "failed" &&
                                candidate.errorMessage
                                  ? candidate.errorMessage
                                  : `${candidate.file.filename} · ${STATUS_LABEL[candidate.status]}`}
                              </span>
                            </span>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-64 flex-col items-start gap-0.5">
                          <p className="font-medium">{candidate.name}</p>
                          <p className="break-all text-muted-foreground">
                            {candidate.status === "failed" &&
                            candidate.errorMessage
                              ? candidate.errorMessage
                              : `${candidate.file.filename} · ${STATUS_LABEL[candidate.status]}`}
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </TableCell>
                  {opening.criteria.map((c) => (
                    <TableCell key={c.id} className="px-2 py-1.5">
                      <MatchCell
                        evaluation={candidate.evaluations.find(
                          (e) => e.criterionId === c.id,
                        )}
                        pending={IN_FLIGHT.has(candidate.status)}
                        criterionName={c.name}
                        onReview={() => openReview(candidate, c.id)}
                      />
                    </TableCell>
                  ))}
                  <TableCell className="sticky right-0 z-10 bg-background px-2 py-1.5 group-hover:bg-muted group-data-[state=selected]:bg-muted">
                    <div className="flex items-center justify-end gap-0.5">
                      <ScoreCell candidate={candidate} />
                      <DecisionMenu
                        openingId={opening.id}
                        candidate={candidate}
                        onError={setActionError}
                      />
                      {candidate.status === "failed" &&
                        candidate.retryable && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            title="Retry"
                            aria-label={`Retry ${candidate.name}`}
                            disabled={pendingIds.has(candidate.id)}
                            onClick={() => void retry(candidate)}
                          >
                            {pendingIds.has(candidate.id) ? (
                              <LoaderCircleIcon className="animate-spin" />
                            ) : (
                              <RotateCcwIcon />
                            )}
                            <span className="hidden sm:inline">Retry</span>
                          </Button>
                        )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        title="See CV"
                        aria-label={`See CV for ${candidate.name}`}
                        onClick={() => openCv(candidate)}
                      >
                        <EyeIcon />
                        <span className="hidden sm:inline">See CV</span>
                      </Button>
                      <CandidateRowMenu
                        opening={opening}
                        candidate={candidate}
                        onViewEvidence={() => setEvidenceFor(candidate)}
                        onReview={(criterionId) =>
                          openReview(candidate, criterionId)
                        }
                        onDelete={() => setDeleteFor(candidate)}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <BulkActionsBar
        count={liveSelection.size}
        busy={bulkBusy}
        onShortlist={() => void bulkDecide("shortlisted")}
        onReject={() => void bulkDecide("passed")}
        onDelete={() => setBulkDeleteOpen(true)}
        onClear={() => setSelectedIds(new Set())}
      />

      <AddCandidatesDialog
        openingId={opening.id}
        open={addOpen}
        onOpenChange={setAddOpen}
      />
      <EvidenceDialog
        opening={opening}
        candidate={evidenceFor}
        open={evidenceFor !== null}
        onOpenChange={(next) => {
          if (!next) setEvidenceFor(null)
        }}
      />
      <ReviewDialog
        opening={opening}
        target={reviewFor}
        onClose={() => setReviewFor(null)}
      />
      <ConfirmDialog
        open={deleteFor !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteFor(null)
        }}
        title={`Delete ${deleteFor?.name ?? "candidate"}?`}
        description="Removes the CV, its scorecard cells and evidence from this opening."
        confirmLabel="Delete"
        destructive
        onConfirm={() =>
          deleteFor ? deleteCandidate(deleteFor) : undefined
        }
      />
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={`Delete ${liveSelection.size} candidates?`}
        description="Removes the selected CVs, their scorecard cells and evidence from this opening."
        confirmLabel="Delete"
        destructive
        onConfirm={() => bulkDelete()}
      />
    </>
  )
}

export default function OpeningDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const openingsStatus = useOpeningsStatus()
  const opening = useOpenings().find((o) => o.id === id)
  const [nonce, setNonce] = useState(0)

  // opening.deleted: when an opening we were viewing disappears from a
  // ready openings store (SSE clears candidates + refresh drops the row),
  // return to the list. The layout effect navigates before paint, so the
  // not-found state never flashes on a deletion.
  const presentRef = useRef<string | null>(null)
  useEffect(() => {
    if (opening) presentRef.current = opening.id
  }, [opening])
  useLayoutEffect(() => {
    if (
      openingsStatus === "ready" &&
      !opening &&
      presentRef.current === id
    ) {
      navigate("/", { replace: true })
    }
  }, [opening, openingsStatus, id, navigate])

  if (!opening) {
    if (openingsStatus === "error") {
      return (
        <div className="flex min-h-0 flex-1 flex-col p-4 pt-0">
          <ErrorPanel
            title="Couldn't load openings"
            body="The opening could not be fetched. Check the backend is running and try again."
            onRetry={() => void refreshOpenings().catch(() => {})}
          />
        </div>
      )
    }
    if (openingsStatus !== "ready") {
      return <OpeningSkeleton />
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
        <p className="text-sm font-medium">Opening not found</p>
        <Link to="/" className="text-sm text-muted-foreground hover:underline">
          Back to openings
        </Link>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 pt-0">
      <OpeningSummary opening={opening} />
      <CandidateSection
        key={`${opening.id}:${nonce}`}
        opening={opening}
        onRetry={() => setNonce((n) => n + 1)}
      />
    </div>
  )
}

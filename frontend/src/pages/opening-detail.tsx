import { useMemo, useState } from "react"
import { useAutoAnimate } from "@formkit/auto-animate/react"
import { cn } from "cn"
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  BadgeCheckIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  FileUpIcon,
  MinusIcon,
  XIcon,
} from "lucide-react"
import { Link, useParams } from "react-router-dom"

import { AddCandidatesDialog } from "@/components/add-candidates-dialog"
import { FileDropzone } from "@/components/file-dropzone"
import { useCvViewer } from "@/components/cv-viewer-context"
import {
  addCandidates,
  duplicateNotice,
  IN_FLIGHT_STATUSES,
  orderCandidates,
  useCandidates,
  type CandidateSort,
} from "@/lib/candidates"
import { useOpenings } from "@/lib/openings"
import type {
  Candidate,
  CandidateStatus,
  CriterionEvaluation,
  MatchStatus,
} from "@/types"
import { Button } from "@/components/ui/button"
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

const MATCH_META: Record<MatchStatus, { icon: typeof CheckIcon; label: string }> = {
  strong: { icon: CheckIcon, label: "Strong" },
  partial: { icon: MinusIcon, label: "Partial" },
  not_found: { icon: XIcon, label: "Not found" },
  needs_review: { icon: CircleAlertIcon, label: "Review" },
  reviewed: { icon: BadgeCheckIcon, label: "Reviewed" },
}

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
}: {
  evaluation?: CriterionEvaluation
  pending?: boolean
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
    <span
      className={cn(
        "inline-flex animate-in items-center gap-1.5 text-xs fade-in duration-200",
        evaluation.status === "needs_review" && "font-semibold",
      )}
    >
      <Icon className="size-3.5" />
      {meta.label}
    </span>
  )
  if (!evaluation.rationale) return cell
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="cursor-default rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {cell}
        </span>
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
    <span className="text-muted-foreground">
      {STATUS_LABEL[candidate.status]}
    </span>
  )
}

export default function OpeningDetailPage() {
  const { id } = useParams()
  const opening = useOpenings().find((o) => o.id === id)
  const candidates = useCandidates(id)
  const [addOpen, setAddOpen] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadNotice, setUploadNotice] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [sort, setSort] = useState<CandidateSort>({
    column: "score",
    dir: "desc",
  })
  const [tbodyRef] = useAutoAnimate<HTMLTableSectionElement>({
    duration: 200,
    easing: "cubic-bezier(0.25, 1, 0.5, 1)",
  })
  const [bodyRef] = useAutoAnimate<HTMLDivElement>({
    duration: 200,
    easing: "cubic-bezier(0.25, 1, 0.5, 1)",
  })
  const { selected, openCv } = useCvViewer()

  const sorted = useMemo(
    () => orderCandidates(candidates, sort),
    [candidates, sort],
  )

  if (!opening) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
        <p className="text-sm font-medium">Opening not found</p>
        <Link to="/" className="text-sm text-muted-foreground hover:underline">
          Back to openings
        </Link>
      </div>
    )
  }

  const inFlight = candidates.filter((c) =>
    IN_FLIGHT.has(c.status),
  ).length

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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 pt-0">
      <div className="flex items-center gap-2">
        {inFlight > 0 && (
          <p className="animate-in text-xs text-muted-foreground fade-in duration-200">
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

      <div className="min-h-0 min-w-0 flex-1" ref={bodyRef}>
          {candidates.length === 0 ? (
            <FileDropzone
              multiple
              accept=".pdf,.docx"
              className={cn(
                "h-full justify-center",
                uploading && "pointer-events-none",
              )}
              title={
                uploading
                  ? "Uploading…"
                  : "No candidates yet — drop CVs here"
              }
              hint="PDF or DOCX · multiple files · or click to browse a batch"
              onFiles={(files) => {
                setUploadError(null)
                setUploadNotice(null)
                setUploading(true)
                addCandidates(opening.id, files)
                  .then((result) =>
                    setUploadNotice(duplicateNotice(result)),
                  )
                  .catch((err) =>
                    setUploadError(
                      err instanceof Error
                        ? err.message
                        : "Could not upload the batch.",
                    ),
                  )
                  .finally(() => setUploading(false))
              }}
            />
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
                    <button
                      type="button"
                      onClick={() => toggleSort("name")}
                      className="inline-flex items-center gap-1 rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      Candidate
                      <SortIcon active={sort.column === "name"} dir={sort.dir} />
                    </button>
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
                    aria-sort={ariaSort("score")}
                    className="sticky right-0 top-0 z-20 h-8 bg-background text-right text-xs"
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort("score")}
                      className="inline-flex items-center gap-1 rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                    >
                      Score
                      <SortIcon active={sort.column === "score"} dir={sort.dir} />
                    </button>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody ref={tbodyRef}>
                {sorted.map((candidate) => (
                  <TableRow
                    key={candidate.id}
                    data-state={
                      selected?.id === candidate.id ? "selected" : undefined
                    }
                    className="group"
                  >
                    <TableCell className="sticky left-0 z-10 max-w-36 bg-background px-2 py-1.5 group-hover:bg-muted group-data-[state=selected]:bg-muted sm:max-w-44">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div
                            tabIndex={0}
                            className="flex flex-col rounded-sm focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                          >
                            <span className="truncate font-medium">
                              {candidate.name}
                            </span>
                            <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                              <span
                                className={cn(
                                  "size-1.5 shrink-0 rounded-full",
                                  IN_FLIGHT.has(candidate.status)
                                    ? "animate-pulse bg-foreground/50"
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
                    </TableCell>
                    {opening.criteria.map((c) => (
                      <TableCell key={c.id} className="px-2 py-1.5">
                        <MatchCell
                          evaluation={candidate.evaluations.find(
                            (e) => e.criterionId === c.id,
                          )}
                          pending={IN_FLIGHT.has(candidate.status)}
                        />
                      </TableCell>
                    ))}
                    <TableCell className="sticky right-0 z-10 bg-background px-2 py-1.5 group-hover:bg-muted group-data-[state=selected]:bg-muted">
                      <div className="flex items-center justify-end gap-1">
                        <ScoreCell candidate={candidate} />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          title="See CV"
                          onClick={() => openCv(candidate)}
                        >
                          <EyeIcon />
                          <span className="hidden sm:inline">See CV</span>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

      <AddCandidatesDialog
        openingId={opening.id}
        open={addOpen}
        onOpenChange={setAddOpen}
      />
    </div>
  )
}

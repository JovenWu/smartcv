import { useState } from "react"
import { cn } from "cn"
import {
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
import { addCandidates, useCandidates } from "@/lib/candidates"
import { useOpenings } from "@/lib/openings"
import type {
  Candidate,
  CandidateStatus,
  CriterionEvaluation,
  MatchStatus,
} from "@/types"
import { Button } from "@/components/ui/button"
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

function MatchCell({ evaluation }: { evaluation?: CriterionEvaluation }) {
  if (!evaluation) {
    return <span className="text-muted-foreground">—</span>
  }
  const meta = MATCH_META[evaluation.status]
  const Icon = meta.icon
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        evaluation.status === "needs_review" && "font-medium",
      )}
    >
      <Icon className="size-3.5" />
      {meta.label}
    </span>
  )
}

function ScoreCell({ candidate }: { candidate: Candidate }) {
  if (candidate.totalScore != null) {
    return (
      <span className="font-medium tabular-nums">{candidate.totalScore}</span>
    )
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
  const { selected, openCv } = useCvViewer()

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

  const awaiting = candidates.filter((c) => c.status === "needs_review").length

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {awaiting > 0
            ? `${awaiting} awaiting review — ranking may change.`
            : `${candidates.length} uploaded.`}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAddOpen(true)}
        >
          <FileUpIcon />
          Add CVs
        </Button>
      </div>
      {uploadError && (
        <p className="text-xs text-destructive">{uploadError}</p>
      )}

      <div className="min-w-0 flex-1">
          {candidates.length === 0 ? (
            <FileDropzone
              multiple
              accept=".pdf,.docx"
              className="h-full justify-center"
              title="No candidates yet — drop CVs here"
              hint="PDF or DOCX · multiple files · or click to browse a batch"
              onFiles={(files) => {
                setUploadError(null)
                addCandidates(opening.id, files).catch((err) =>
                  setUploadError(
                    err instanceof Error
                      ? err.message
                      : "Could not upload the batch.",
                  ),
                )
              }}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-8 min-w-44 text-xs">
                    Candidate
                  </TableHead>
                  {opening.criteria.map((c) => (
                    <TableHead key={c.id} className="h-8 max-w-36 text-xs">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            tabIndex={0}
                            className="block truncate font-normal"
                          >
                            {c.name}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-64">
                          <p className="font-medium">{c.name}</p>
                          {c.description && (
                            <p className="text-muted-foreground">
                              {c.description}
                            </p>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    </TableHead>
                  ))}
                  <TableHead className="h-8 text-right text-xs">
                    Score
                  </TableHead>
                  <TableHead className="h-8 w-8">
                    <span className="sr-only">CV</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map((candidate) => (
                  <TableRow
                    key={candidate.id}
                    data-state={
                      selected?.id === candidate.id ? "selected" : undefined
                    }
                  >
                    <TableCell className="px-2 py-1.5">
                      <div className="flex flex-col">
                        <span className="font-medium">
                          {candidate.name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {candidate.status === "failed" &&
                          candidate.errorMessage
                            ? candidate.errorMessage
                            : `${candidate.file.filename} · ${STATUS_LABEL[candidate.status]}`}
                        </span>
                      </div>
                    </TableCell>
                    {opening.criteria.map((c) => (
                      <TableCell key={c.id} className="px-2 py-1.5">
                        <MatchCell
                          evaluation={candidate.evaluations.find(
                            (e) => e.criterionId === c.id,
                          )}
                        />
                      </TableCell>
                    ))}
                    <TableCell className="px-2 py-1.5 text-right">
                      <ScoreCell candidate={candidate} />
                    </TableCell>
                    <TableCell className="px-2 py-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => openCv(candidate)}
                      >
                        <EyeIcon />
                        See CV
                      </Button>
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

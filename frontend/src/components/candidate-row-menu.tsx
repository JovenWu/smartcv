import {
  CircleAlertIcon,
  EllipsisIcon,
  EyeIcon,
  FileSearchIcon,
  Trash2Icon,
} from "lucide-react"

import { useCvViewer } from "@/components/cv-viewer-context"
import type { Candidate, Opening } from "@/types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * Per-row overflow menu: open the CV, inspect evidence, jump into a
 * needs_review criterion, or delete the candidate (parent confirms).
 */
export function CandidateRowMenu({
  opening,
  candidate,
  onViewEvidence,
  onReview,
  onDelete,
}: {
  opening: Opening
  candidate: Candidate
  onViewEvidence: () => void
  onReview: (criterionId: string) => void
  onDelete: () => void
}) {
  const { openCv } = useCvViewer()
  const flagged = opening.criteria.filter((criterion) =>
    candidate.evaluations.some(
      (e) => e.criterionId === criterion.id && e.status === "needs_review",
    ),
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Actions for ${candidate.name}`}
        >
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => openCv(candidate)}>
          <EyeIcon />
          See CV
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onViewEvidence}>
          <FileSearchIcon />
          View evidence
        </DropdownMenuItem>
        {flagged.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <CircleAlertIcon />
              Review flagged
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {flagged.map((criterion) => (
                <DropdownMenuItem
                  key={criterion.id}
                  onSelect={() => onReview(criterion.id)}
                >
                  <span className="truncate">{criterion.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2Icon />
          Delete candidate
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

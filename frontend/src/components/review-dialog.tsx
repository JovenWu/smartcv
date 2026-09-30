import { useState } from "react"
import { LoaderCircleIcon } from "lucide-react"
import { cn } from "cn"

import { MATCH_META } from "@/components/match-meta"
import { reviewCriterion } from "@/lib/candidates"
import type {
  Candidate,
  Criterion,
  CriterionEvaluation,
  Opening,
} from "@/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

export interface ReviewTarget {
  candidate: Candidate
  criterion: Criterion
  evaluation: CriterionEvaluation
}

type MatchLevel = "not_found" | "partial" | "strong"

const LEVELS: MatchLevel[] = ["not_found", "partial", "strong"]

function ReviewDialogContent({
  opening,
  target,
  onClose,
}: {
  opening: Opening
  target: ReviewTarget
  onClose: () => void
}) {
  const [level, setLevel] = useState<MatchLevel | null>(null)
  const [note, setNote] = useState(target.evaluation.reviewNote ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (!level || busy) return
    setBusy(true)
    setError(null)
    try {
      await reviewCriterion(
        opening.id,
        target.candidate.id,
        target.criterion.id,
        { matchLevel: level, reviewNote: note.trim() || undefined },
      )
      onClose()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save the review.",
      )
    } finally {
      setBusy(false)
    }
  }

  const meta = MATCH_META[target.evaluation.status]

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Review — {target.criterion.name}</DialogTitle>
        <DialogDescription>
          {target.candidate.name} — flagged{" "}
          <span className="font-medium text-foreground">
            {meta.label.toLowerCase()}
          </span>{" "}
          by the screener.
        </DialogDescription>
      </DialogHeader>

      {target.evaluation.rationale && (
        <p className="rounded-lg border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
          {target.evaluation.rationale}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <Label>Your call</Label>
        <div role="radiogroup" aria-label="Match level" className="flex gap-1">
          {LEVELS.map((value) => {
            const { icon: Icon, label } = MATCH_META[value]
            const active = level === value
            return (
              <Button
                key={value}
                type="button"
                role="radio"
                aria-checked={active}
                variant={active ? "secondary" : "outline"}
                size="sm"
                className={cn("flex-1", !active && "text-muted-foreground")}
                onClick={() => setLevel(value)}
              >
                <Icon />
                {label}
              </Button>
            )
          })}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="review-note">Note (optional)</Label>
        <Textarea
          id="review-note"
          rows={3}
          placeholder="Why this excerpt does or doesn't count…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <DialogFooter showCloseButton>
        <Button size="sm" disabled={!level || busy} onClick={() => void save()}>
          {busy && <LoaderCircleIcon className="animate-spin" />}
          Save review
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

/**
 * Recruiter override for a needs_review cell: pick a match level and an
 * optional note; reviewCriterion PATCHes the evaluation to "reviewed".
 * The content remounts per target (keyed), so fields always start clean.
 */
export function ReviewDialog({
  opening,
  target,
  onClose,
}: {
  opening: Opening
  target: ReviewTarget | null
  onClose: () => void
}) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      {target && (
        <ReviewDialogContent
          key={`${target.candidate.id}:${target.criterion.id}`}
          opening={opening}
          target={target}
          onClose={onClose}
        />
      )}
    </Dialog>
  )
}

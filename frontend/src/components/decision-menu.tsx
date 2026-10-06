import { useState } from "react"
import {
  ChevronDownIcon,
  CircleDashedIcon,
  CircleIcon,
  CircleXIcon,
  StarIcon,
} from "lucide-react"
import { cn } from "cn"

import { setDecision } from "@/lib/candidates"
import type { Candidate, CandidateDecision } from "@/types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const DECISION_META: Record<
  CandidateDecision,
  { icon: typeof CircleIcon; label: string }
> = {
  undecided: { icon: CircleDashedIcon, label: "Undecided" },
  shortlisted: { icon: StarIcon, label: "Shortlisted" },
  passed: { icon: CircleXIcon, label: "Rejected" },
}

export function DecisionMenu({
  openingId,
  candidate,
  onError,
}: {
  openingId: string
  candidate: Candidate
  onError?: (message: string) => void
}) {
  const [pending, setPending] = useState(false)
  const meta = DECISION_META[candidate.decision] ?? DECISION_META.undecided
  const Icon = meta.icon

  const decide = async (decision: CandidateDecision) => {
    if (decision === candidate.decision || pending) return
    setPending(true)
    try {
      await setDecision(openingId, candidate.id, decision)
    } catch (error) {
      onError?.(
        error instanceof Error
          ? error.message
          : "Could not update the decision.",
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          aria-label={`Decision for ${candidate.name}: ${meta.label}`}
          className={cn(
            "h-7 gap-1 px-1.5 text-xs",
            candidate.decision === "undecided" && "text-muted-foreground",
          )}
        >
          <Icon />
          <span className="hidden sm:inline">{meta.label}</span>
          <ChevronDownIcon className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={candidate.decision}
          onValueChange={(value) =>
            void decide(value as CandidateDecision)
          }
        >
          <DropdownMenuRadioItem value="undecided">
            <CircleDashedIcon />
            Undecided
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="shortlisted">
            <StarIcon />
            Shortlisted
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="passed">
            <CircleXIcon />
            Rejected
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

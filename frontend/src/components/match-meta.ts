import {
  ChartPieIcon,
  CircleCheckBigIcon,
  CircleQuestionMarkIcon,
  CircleXIcon,
  UserCheckIcon,
  type LucideIcon,
} from "lucide-react"

import type { VariantProps } from "class-variance-authority"

import { badgeVariants } from "@/components/ui/badge"
import type { MatchStatus } from "@/types"

type BadgeVariant = VariantProps<typeof badgeVariants>["variant"]

/** Icon, label and badge tone per status. needs_review stays solid gold —
 *  the actionable state — while resolved states use soft tinted badges. */
export const MATCH_META: Record<
  MatchStatus,
  {
    icon: LucideIcon
    label: string
    badgeVariant: BadgeVariant
    badgeClass?: string
  }
> = {
  strong: {
    icon: CircleCheckBigIcon,
    label: "Strong",
    badgeVariant: "secondary",
    badgeClass:
      "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400",
  },
  partial: {
    icon: ChartPieIcon,
    label: "Partial",
    badgeVariant: "secondary",
    badgeClass:
      "bg-amber-500/15 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400",
  },
  not_found: {
    icon: CircleXIcon,
    label: "Not found",
    badgeVariant: "destructive",
  },
  needs_review: {
    icon: CircleQuestionMarkIcon,
    label: "Review",
    badgeVariant: "default",
  },
  reviewed: {
    icon: UserCheckIcon,
    label: "Reviewed",
    badgeVariant: "secondary",
    badgeClass:
      "bg-sky-500/15 text-sky-700 dark:bg-sky-500/10 dark:text-sky-400",
  },
}

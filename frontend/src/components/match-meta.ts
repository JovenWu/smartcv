import {
  BadgeCheckIcon,
  CheckIcon,
  CircleAlertIcon,
  MinusIcon,
  XIcon,
} from "lucide-react"

import type { MatchStatus } from "@/types"

/** Icon + label per evaluation status — monochrome, never color-only. */
export const MATCH_META: Record<
  MatchStatus,
  { icon: typeof CheckIcon; label: string }
> = {
  strong: { icon: CheckIcon, label: "Strong" },
  partial: { icon: MinusIcon, label: "Partial" },
  not_found: { icon: XIcon, label: "Not found" },
  needs_review: { icon: CircleAlertIcon, label: "Review" },
  reviewed: { icon: BadgeCheckIcon, label: "Reviewed" },
}

import type {
  Candidate,
  Criterion,
  CriterionEvaluation,
  EvidenceSpan,
} from "@/types"

export interface SpanGroup {
  /** null for excerpts not referenced by any evaluation. */
  criterion: Criterion | null
  evaluation?: CriterionEvaluation
  spans: EvidenceSpan[]
}

/**
 * Group a candidate's evidence spans under their criterion, in the opening's
 * criteria order. Spans no evaluation points to land in a trailing group.
 */
export function groupEvidenceSpans(
  candidate: Candidate,
  criteria: Criterion[],
  spans: EvidenceSpan[],
): SpanGroup[] {
  const byId = new Map(spans.map((s) => [s.id, s]))
  const referenced = new Set<string>()
  const groups: SpanGroup[] = []
  for (const criterion of criteria) {
    const evaluation = candidate.evaluations.find(
      (e) => e.criterionId === criterion.id,
    )
    const groupSpans = (evaluation?.evidenceSpanIds ?? [])
      .map((id) => byId.get(id))
      .filter((s): s is EvidenceSpan => Boolean(s))
    groupSpans.forEach((s) => referenced.add(s.id))
    if (groupSpans.length > 0)
      groups.push({ criterion, evaluation, spans: groupSpans })
  }
  const unreferenced = spans.filter((s) => !referenced.has(s.id))
  if (unreferenced.length > 0) {
    groups.push({ criterion: null, spans: unreferenced })
  }
  return groups
}

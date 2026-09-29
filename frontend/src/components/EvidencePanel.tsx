import { useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  FileQuestion,
  RotateCcw,
  TriangleAlert,
  UserCheck,
} from "lucide-react";
import {
  getSpans,
  previewUrl,
  retryCandidate,
  reviewCriterion,
} from "@/api";
import type {
  CandidateResult,
  CriterionEvaluation,
  EvidenceSpan,
  JobSnapshot,
  MatchStatus,
  ReviewMatchLevel,
} from "@/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const LOW_CONFIDENCE = 0.5;

const MATCH_LABEL: Record<MatchStatus, string> = {
  strong: "Strong",
  partial: "Partial",
  not_found: "Not found",
  needs_review: "Needs review",
  reviewed: "Reviewed",
};

const LEVELS: { value: ReviewMatchLevel; label: string }[] = [
  { value: "not_found", label: "Not found" },
  { value: "partial", label: "Partial" },
  { value: "strong", label: "Strong" },
];

interface Draft {
  level: ReviewMatchLevel | null;
  note: string;
}

interface EvidencePanelProps {
  job: JobSnapshot;
  candidate: CandidateResult | null;
  onCandidateUpdated: (candidate: CandidateResult) => void;
}

export function EvidencePanel({
  job,
  candidate,
  onCandidateUpdated,
}: EvidencePanelProps) {
  const [spans, setSpans] = useState<Map<string, EvidenceSpan> | null>(null);
  const [previewOk, setPreviewOk] = useState<boolean | null>(null);
  const [previewPage, setPreviewPage] = useState(1);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The app remounts this panel via key={candidate.id}, so per-candidate
  // state resets on selection change without a synchronous reset effect.
  const candidateId = candidate?.id ?? null;

  useEffect(() => {
    if (!candidateId) return;

    let cancelled = false;
    getSpans(job.id, candidateId)
      .then((list) => {
        if (!cancelled)
          setSpans(new Map(list.map((span) => [span.id, span])));
      })
      .catch(() => {
        if (!cancelled) setSpans(new Map());
      });

    // Probe the preview endpoint, then abort before downloading the body.
    const controller = new AbortController();
    fetch(previewUrl(job.id, candidateId), { signal: controller.signal })
      .then((response) => {
        if (!cancelled) setPreviewOk(response.ok);
        void response.body?.cancel().catch(() => {});
      })
      .catch(() => {
        if (!cancelled) setPreviewOk(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [job.id, candidateId]);

  const evalsByCriterion = useMemo(
    () =>
      new Map(
        (candidate?.evaluations ?? []).map((e) => [e.criterion_id, e]),
      ),
    [candidate],
  );

  const setDraft = (criterionId: string, patch: Partial<Draft>) =>
    setDrafts((prev) => {
      const current = prev[criterionId] ?? { level: null, note: "" };
      return { ...prev, [criterionId]: { ...current, ...patch } };
    });

  const saveReview = async (criterionId: string) => {
    if (!candidate) return;
    const draft = drafts[criterionId];
    if (!draft?.level) return;
    setSaving(criterionId);
    setError(null);
    try {
      const updated = await reviewCriterion(
        job.id,
        candidate.id,
        criterionId,
        draft.level,
        draft.note.trim() || null,
      );
      onCandidateUpdated(updated);
      setDrafts((prev) => ({
        ...prev,
        [criterionId]: { level: null, note: "" },
      }));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save the review.",
      );
    } finally {
      setSaving(null);
    }
  };

  const retry = async () => {
    if (!candidate) return;
    setError(null);
    try {
      onCandidateUpdated(await retryCandidate(job.id, candidate.id));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not retry the file.",
      );
    }
  };

  if (!candidate) {
    return (
      <Card className="lg:sticky lg:top-4">
        <CardHeader>
          <CardTitle>Evidence</CardTitle>
          <CardDescription>
            Select a candidate to inspect evidence and adjust evaluations.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate">{candidate.filename}</CardTitle>
            <CardDescription className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge
                variant={
                  candidate.status === "failed"
                    ? "destructive"
                    : candidate.status === "needs_review"
                      ? "secondary"
                      : "outline"
                }
              >
                {candidate.status.replace("_", " ")}
              </Badge>
              {candidate.total_score !== null && (
                <span className="font-mono tabular-nums">
                  {candidate.total_score.toFixed(2)}
                </span>
              )}
            </CardDescription>
          </div>
          {candidate.status === "failed" && candidate.retryable && (
            <Button variant="outline" size="sm" onClick={retry}>
              <RotateCcw />
              Retry
            </Button>
          )}
        </div>
        {candidate.error_message && (
          <p className="text-xs text-muted-foreground">
            {candidate.error_message}
          </p>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {candidate.evaluations.length === 0 ? (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <FileQuestion className="mt-0.5 size-3.5 shrink-0" />
            No extracted evaluations — this file needs manual handling. The
            scorecard does not assign it a score.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {job.criteria.map((criterion) => {
              const evaluation = evalsByCriterion.get(criterion.id);
              return (
                <li
                  key={criterion.id}
                  className="rounded-md border p-2.5 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{criterion.name}</span>
                    <Badge variant="muted">w{criterion.weight}</Badge>
                    {evaluation && (
                      <>
                        <span className="text-muted-foreground">
                          {MATCH_LABEL[evaluation.status]} ·{" "}
                          {Math.round(evaluation.confidence * 100)}%
                        </span>
                        {evaluation.manual_fraction !== null && (
                          <Badge variant="outline">
                            <UserCheck />
                            Manual
                          </Badge>
                        )}
                        {evaluation.status === "needs_review" && (
                          <Badge variant="secondary">
                            <TriangleAlert />
                            Needs review
                          </Badge>
                        )}
                        {evaluation.confidence < LOW_CONFIDENCE && (
                          <Badge variant="secondary">
                            <TriangleAlert />
                            Low confidence
                          </Badge>
                        )}
                      </>
                    )}
                  </div>

                  {evaluation ? (
                    <EvaluationEvidence
                      evaluation={evaluation}
                      span={
                        evaluation.evidence_span_id
                          ? (spans?.get(evaluation.evidence_span_id) ?? null)
                          : null
                      }
                      spansLoaded={spans !== null}
                      onJumpToPage={setPreviewPage}
                    />
                  ) : (
                    <p className="mt-1.5 text-muted-foreground">
                      Not evaluated yet.
                    </p>
                  )}

                  {evaluation && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t pt-2">
                      <span className="text-muted-foreground">Override:</span>
                      {LEVELS.map((level) => {
                        const draft = drafts[criterion.id];
                        const active =
                          draft?.level === level.value ||
                          (draft?.level === undefined &&
                            evaluation.manual_fraction !== null &&
                            LEVELS[Math.round(evaluation.manual_fraction * 2)]
                              .value === level.value);
                        return (
                          <Button
                            key={level.value}
                            variant={
                              draft?.level === level.value
                                ? "default"
                                : "outline"
                            }
                            size="xs"
                            aria-pressed={draft?.level === level.value}
                            className={cn(
                              active && draft?.level === undefined && "opacity-70",
                            )}
                            onClick={() =>
                              setDraft(criterion.id, { level: level.value })
                            }
                            disabled={saving === criterion.id}
                          >
                            {level.label}
                          </Button>
                        );
                      })}
                      <Input
                        aria-label="Review note"
                        value={drafts[criterion.id]?.note ?? ""}
                        onChange={(e) =>
                          setDraft(criterion.id, { note: e.target.value })
                        }
                        placeholder="Note (optional)"
                        className="h-6 w-32 text-xs"
                        disabled={saving === criterion.id}
                      />
                      <Button
                        size="xs"
                        variant="secondary"
                        onClick={() => saveReview(criterion.id)}
                        disabled={
                          saving === criterion.id ||
                          !drafts[criterion.id]?.level
                        }
                      >
                        {saving === criterion.id ? "Saving…" : "Save review"}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {error && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Review failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {previewOk === true && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium">
                Normalized preview · page {previewPage}
              </p>
              <a
                href={previewUrl(job.id, candidate.id)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
              >
                Open in new tab
                <ExternalLink className="size-3" aria-hidden />
              </a>
            </div>
            <iframe
              key={previewPage}
              title="CV preview"
              src={`${previewUrl(job.id, candidate.id)}#page=${previewPage}`}
              className="h-72 w-full rounded-md border bg-muted"
            />
          </div>
        )}
        {previewOk === false && (
          <p className="text-xs text-muted-foreground">
            No preview available for this file.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function EvaluationEvidence({
  evaluation,
  span,
  spansLoaded,
  onJumpToPage,
}: {
  evaluation: CriterionEvaluation;
  span: EvidenceSpan | null;
  spansLoaded: boolean;
  onJumpToPage: (page: number) => void;
}) {
  if (!spansLoaded) {
    return <Skeleton className="mt-1.5 h-8 w-full" />;
  }
  if (span) {
    return (
      <figure className="mt-1.5 border-l-2 border-border pl-2">
        <blockquote className="text-muted-foreground">
          “{span.text}”
        </blockquote>
        <figcaption>
          <button
            type="button"
            onClick={() => onJumpToPage(span.page_number)}
            className="text-[11px] text-foreground underline-offset-4 hover:underline"
          >
            Page {span.page_number}
          </button>
        </figcaption>
      </figure>
    );
  }
  if (evaluation.status === "not_found") {
    return (
      <p className="mt-1.5 text-muted-foreground">
        No matching excerpt found — absence of evidence is not proof of
        absence.
      </p>
    );
  }
  return (
    <p className="mt-1.5 text-muted-foreground">
      No verified excerpt is linked to this evaluation.
    </p>
  );
}

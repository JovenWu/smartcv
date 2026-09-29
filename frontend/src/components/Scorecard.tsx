import {
  Check,
  ChevronRight,
  CircleDot,
  Loader,
  TriangleAlert,
  UserCheck,
  X,
} from "lucide-react";
import type {
  CandidateResult,
  CandidateStatus,
  JobSnapshot,
  MatchStatus,
} from "@/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const RANKABLE: ReadonlySet<CandidateStatus> = new Set([
  "complete",
  "needs_review",
]);

const STATUS_LABEL: Record<CandidateStatus, string> = {
  queued: "Queued",
  extracting: "Extracting",
  evaluating: "Evaluating",
  complete: "Complete",
  needs_review: "Needs review",
  failed: "Failed",
};

const MATCH_ICON: Record<MatchStatus, React.ReactNode> = {
  strong: <Check aria-hidden />,
  partial: <CircleDot aria-hidden />,
  not_found: <X aria-hidden className="text-muted-foreground" />,
  needs_review: <TriangleAlert aria-hidden />,
  reviewed: <UserCheck aria-hidden />,
};

function sortedCandidates(
  candidates: CandidateResult[],
): { ranked: CandidateResult[]; ranks: Map<string, number> } {
  const rankable = candidates
    .filter(
      (c) => c.total_score !== null && RANKABLE.has(c.status),
    )
    .sort(
      (a, b) =>
        (b.total_score ?? 0) - (a.total_score ?? 0) ||
        a.upload_order - b.upload_order,
    );
  const rankedIds = new Set(rankable.map((c) => c.id));
  const rest = candidates
    .filter((c) => !rankedIds.has(c.id))
    .sort((a, b) => a.upload_order - b.upload_order);
  const ranks = new Map(rankable.map((c, i) => [c.id, i + 1]));
  return { ranked: [...rankable, ...rest], ranks };
}

interface ScorecardProps {
  job: JobSnapshot;
  selectedId: string | null;
  onSelect: (candidateId: string) => void;
}

export function Scorecard({ job, selectedId, onSelect }: ScorecardProps) {
  const { ranked, ranks } = sortedCandidates(job.candidates);
  const total = Math.max(job.total_count, 1);
  const progress = Math.min(100, (job.completed_count / total) * 100);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4">
        <div>
          <CardTitle>Scorecard</CardTitle>
          <CardDescription>
            {job.is_final
              ? "Final ranking — all files processed."
              : "Provisional ranking — updates as each CV finishes."}
          </CardDescription>
        </div>
        <div className="flex flex-col items-end gap-1 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {job.completed_count} of {job.total_count} processed
          </span>
          <div
            role="progressbar"
            aria-label="Screening progress"
            aria-valuemin={0}
            aria-valuemax={job.total_count}
            aria-valuenow={job.completed_count}
            className="h-1 w-32 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-foreground transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        {ranked.length === 0 ? (
          <p className="px-4 pb-4 text-xs text-muted-foreground">
            No CVs uploaded yet — upload a batch to start screening.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">Rank</TableHead>
                  <TableHead className="min-w-36">Candidate</TableHead>
                  <TableHead>Status</TableHead>
                  {job.criteria.map((criterion) => (
                    <TableHead
                      key={criterion.id}
                      title={`Weight ${criterion.weight}`}
                    >
                      {criterion.name}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {ranked.map((candidate) => {
                  const rank = ranks.get(candidate.id);
                  const evalsByCriterion = new Map(
                    candidate.evaluations.map((e) => [e.criterion_id, e]),
                  );
                  return (
                    <TableRow
                      key={candidate.id}
                      aria-label={candidate.filename}
                      data-state={
                        candidate.id === selectedId ? "selected" : undefined
                      }
                      onClick={() => onSelect(candidate.id)}
                      className="cursor-pointer"
                    >
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {rank ? `#${rank}` : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="truncate font-medium">
                            {candidate.filename}
                          </span>
                          {candidate.error_message && (
                            <span className="truncate text-[11px] text-muted-foreground">
                              {candidate.error_message}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            candidate.status === "failed"
                              ? "destructive"
                              : candidate.status === "complete"
                                ? "default"
                                : candidate.status === "needs_review"
                                  ? "secondary"
                                  : "outline"
                          }
                        >
                          {(candidate.status === "extracting" ||
                            candidate.status === "evaluating") && (
                            <Loader aria-hidden className="animate-spin" />
                          )}
                          {STATUS_LABEL[candidate.status]}
                        </Badge>
                      </TableCell>
                      {job.criteria.map((criterion) => {
                        const evaluation = evalsByCriterion.get(criterion.id);
                        if (!evaluation) {
                          return (
                            <TableCell
                              key={criterion.id}
                              className="text-muted-foreground"
                            >
                              —
                            </TableCell>
                          );
                        }
                        const fraction =
                          evaluation.manual_fraction ??
                          evaluation.model_fraction;
                        return (
                          <TableCell key={criterion.id}>
                            <span
                              aria-label={`${criterion.name}: ${evaluation.status}`}
                              title={`${criterion.name}: ${evaluation.status}`}
                              className="inline-flex items-center gap-1 text-xs"
                            >
                              {MATCH_ICON[evaluation.status]}
                              <span className="tabular-nums text-muted-foreground">
                                {fraction.toFixed(1)}
                              </span>
                            </span>
                          </TableCell>
                        );
                      })}
                      <TableCell className="text-right font-mono text-sm tabular-nums">
                        {candidate.total_score !== null
                          ? candidate.total_score.toFixed(2)
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn("h-6 w-6")}
                          aria-label={`Inspect ${candidate.filename}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelect(candidate.id);
                          }}
                        >
                          <ChevronRight />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

import { useCallback, useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import type { JobSnapshot } from "@/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { RoleCriteriaForm } from "@/components/RoleCriteriaForm";
import { CvUploadPanel } from "@/components/CvUploadPanel";
import { Scorecard } from "@/components/Scorecard";
import { EvidencePanel } from "@/components/EvidencePanel";
import { useJobEvents } from "@/hooks/useJobEvents";

type Theme = "system" | "light" | "dark";

const THEME_ORDER: Theme[] = ["system", "light", "dark"];
const THEME_ICON: Record<Theme, React.ReactNode> = {
  system: <Monitor aria-hidden />,
  light: <Sun aria-hidden />,
  dark: <Moon aria-hidden />,
};

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("smartcv-theme") as Theme) ?? "system",
  );

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () =>
      document.documentElement.classList.toggle(
        "dark",
        theme === "dark" || (theme === "system" && media.matches),
      );
    apply();
    localStorage.setItem("smartcv-theme", theme);
    if (theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  const cycle = useCallback(
    () =>
      setTheme(
        (prev) =>
          THEME_ORDER[(THEME_ORDER.indexOf(prev) + 1) % THEME_ORDER.length],
      ),
    [],
  );
  return [theme, cycle];
}

export default function App() {
  const [jobId, setJobId] = useState<string | null>(null);
  const { job, live, streamError, mergeCandidate, seedJob } =
    useJobEvents(jobId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [theme, cycleTheme] = useTheme();

  const onJobCreated = useCallback(
    (created: JobSnapshot) => {
      seedJob(created);
      setJobId(created.id);
    },
    [seedJob],
  );

  const reset = () => {
    setJobId(null);
    setSelectedId(null);
  };

  const selected = job?.candidates.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-12 max-w-7xl items-center gap-3 px-4">
          <div className="flex items-baseline gap-2">
            <h1 className="text-sm font-semibold tracking-tight">SmartCV</h1>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              Evidence-based screening — decisions stay with the recruiter
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {job && (
              <>
                {job.is_final ? (
                  <Badge variant="secondary">Complete</Badge>
                ) : streamError ? (
                  <Badge variant="outline">Reconnecting…</Badge>
                ) : live ? (
                  <Badge variant="outline">
                    <span className="size-1.5 animate-pulse rounded-full bg-foreground" />
                    Live
                  </Badge>
                ) : (
                  <Badge variant="outline">Connecting…</Badge>
                )}
                <Button variant="ghost" size="sm" onClick={reset}>
                  New role
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={cycleTheme}
              aria-label={`Theme: ${theme}`}
              title={`Theme: ${theme}`}
            >
              {THEME_ICON[theme]}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-4">
        {!job ? (
          <div className="mx-auto max-w-2xl">
            <RoleCriteriaForm onJobCreated={onJobCreated} />
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
            <aside className="flex flex-col gap-4">
              <Card>
                <CardHeader>
                  <CardTitle className="truncate">{job.title}</CardTitle>
                  <CardDescription>
                    Confirmed criteria — weights drive the score.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  <ul className="flex flex-col">
                    {job.criteria.map((criterion, index) => (
                      <li key={criterion.id} className="text-xs">
                        {index > 0 && <Separator className="my-1.5" />}
                        <div className="flex items-center justify-between gap-2 py-1">
                          <span className="min-w-0">
                            <span className="block truncate font-medium">
                              {criterion.name}
                            </span>
                            {criterion.description && (
                              <span className="block truncate text-muted-foreground">
                                {criterion.description}
                              </span>
                            )}
                          </span>
                          <Badge variant="muted">w{criterion.weight}</Badge>
                        </div>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
              <CvUploadPanel
                jobId={job.id}
                onUploaded={(result) =>
                  result.candidates.forEach(mergeCandidate)
                }
              />
            </aside>

            <div className="grid content-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
              <Scorecard
                job={job}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
              <EvidencePanel
                key={selected?.id ?? "none"}
                job={job}
                candidate={selected}
                onCandidateUpdated={mergeCandidate}
              />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

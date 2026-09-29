import { useRef, useState } from "react";
import { CircleAlert, Plus, Sparkles, X } from "lucide-react";
import { createJob, suggestWeights } from "@/api";
import type { Criterion, JobSnapshot } from "@/types";
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
import { Label } from "@/components/ui/label";

interface CriterionDraft {
  id: string;
  name: string;
  description: string;
  weight: string;
  confidence: number | null;
}

interface RoleCriteriaFormProps {
  onJobCreated: (job: JobSnapshot) => void;
}

const EMPTY_DRAFT = (id: string): CriterionDraft => ({
  id,
  name: "",
  description: "",
  weight: "",
  confidence: null,
});

export function RoleCriteriaForm({ onJobCreated }: RoleCriteriaFormProps) {
  const nextId = useRef(2);
  const [title, setTitle] = useState("");
  const [rows, setRows] = useState<CriterionDraft[]>([
    EMPTY_DRAFT("criterion-1"),
  ]);
  const [errors, setErrors] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [creating, setCreating] = useState(false);

  const updateRow = (id: string, patch: Partial<CriterionDraft>) =>
    setRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );

  const addRow = () =>
    setRows((prev) => [
      ...prev,
      EMPTY_DRAFT(`criterion-${nextId.current++}`),
    ]);

  const removeRow = (id: string) =>
    setRows((prev) => prev.filter((row) => row.id !== id));

  const namedRows = rows.filter((row) => row.name.trim().length > 0);

  const requestSuggestions = async () => {
    setErrors([]);
    setSuggesting(true);
    try {
      const { suggestions } = await suggestWeights(
        namedRows.map((row) => ({
          id: row.id,
          name: row.name.trim(),
          description: row.description.trim(),
        })),
      );
      const byCriterion = new Map(
        suggestions.map((s) => [s.criterion_id, s]),
      );
      setRows((prev) =>
        prev.map((row) => {
          const suggestion = byCriterion.get(row.id);
          if (!suggestion) return row;
          return {
            ...row,
            weight: String(suggestion.proposed_weight),
            confidence: suggestion.confidence,
          };
        }),
      );
    } catch {
      setErrors([
        "Weight suggestions are unavailable — enter weights manually for each criterion.",
      ]);
    } finally {
      setSuggesting(false);
    }
  };

  const validate = (): Criterion[] | null => {
    const problems: string[] = [];
    if (title.trim().length === 0) problems.push("Enter a role title.");
    if (namedRows.length === 0)
      problems.push("Add at least one criterion with a name.");
    for (const row of namedRows) {
      const weight = Number(row.weight);
      if (!Number.isInteger(weight) || weight < 1 || weight > 5) {
        problems.push(
          `Weight for "${row.name.trim()}" must be a whole number between 1 and 5.`,
        );
      }
    }
    setErrors(problems);
    if (problems.length > 0) return null;
    return namedRows.map((row) => ({
      id: row.id,
      name: row.name.trim(),
      description: row.description.trim(),
      weight: Number(row.weight),
    }));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const criteria = validate();
    if (!criteria) return;
    setCreating(true);
    try {
      onJobCreated(await createJob(title.trim(), criteria));
    } catch (error) {
      setErrors([
        error instanceof Error ? error.message : "Failed to create the job.",
      ]);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Define the role</CardTitle>
        <CardDescription>
          List what matters, review suggested weights, then confirm. Nothing is
          scored until you confirm.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="role-title">Role title</Label>
            <Input
              id="role-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Backend Engineer"
              disabled={creating}
            />
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Screening criteria</legend>
            <div className="flex items-center justify-between">
              <Label>Criteria</Label>
              <Button
                variant="outline"
                size="sm"
                onClick={requestSuggestions}
                disabled={suggesting || creating || namedRows.length === 0}
              >
                <Sparkles />
                {suggesting ? "Suggesting…" : "Suggest weights"}
              </Button>
            </div>

            {rows.map((row, index) => {
              const weightInvalid =
                row.name.trim().length > 0 &&
                row.weight !== "" &&
                (!Number.isInteger(Number(row.weight)) ||
                  Number(row.weight) < 1 ||
                  Number(row.weight) > 5);
              return (
                <div
                  key={row.id}
                  className="grid grid-cols-1 gap-1.5 rounded-md border p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_64px_auto_28px] sm:items-center sm:border-0 sm:p-0"
                >
                  <Input
                    aria-label="Criterion name"
                    value={row.name}
                    onChange={(e) =>
                      updateRow(row.id, {
                        name: e.target.value,
                        confidence: null,
                      })
                    }
                    placeholder={`Criterion ${index + 1}`}
                    disabled={creating}
                  />
                  <Input
                    aria-label="Description (optional)"
                    value={row.description}
                    onChange={(e) =>
                      updateRow(row.id, { description: e.target.value })
                    }
                    placeholder="What to look for (optional)"
                    disabled={creating}
                  />
                  <Input
                    aria-label="Weight (1–5)"
                    type="number"
                    min={1}
                    max={5}
                    step={1}
                    value={row.weight}
                    aria-invalid={weightInvalid || undefined}
                    onChange={(e) =>
                      updateRow(row.id, {
                        weight: e.target.value,
                        confidence: null,
                      })
                    }
                    disabled={creating}
                  />
                  <span className="min-w-16 text-left">
                    {row.confidence !== null && (
                      <Badge variant="muted">
                        {Math.round(row.confidence * 100)}% confidence
                      </Badge>
                    )}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`Remove criterion ${index + 1}`}
                    onClick={() => removeRow(row.id)}
                    disabled={creating || rows.length === 1}
                  >
                    <X />
                  </Button>
                </div>
              );
            })}

            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={addRow}
                disabled={creating}
              >
                <Plus />
                Add criterion
              </Button>
            </div>
          </fieldset>

          {errors.length > 0 && (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>Check the form</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={creating} className="self-start">
            {creating ? "Creating…" : "Confirm weights and create job"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

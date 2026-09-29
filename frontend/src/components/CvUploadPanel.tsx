import { useState } from "react";
import { CircleAlert, FileText, FileUp, X } from "lucide-react";
import { uploadCvs } from "@/api";
import {
  ACCEPTED_EXTENSIONS,
  MAX_BATCH_FILES,
  MAX_FILE_BYTES,
  type BatchUploadResponse,
  type CandidateResult,
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
import { Label } from "@/components/ui/label";

interface CvUploadPanelProps {
  jobId: string;
  onUploaded?: (result: BatchUploadResponse) => void;
}

interface RejectedFile {
  name: string;
  reason: string;
}

function describeRejection(file: File): string | null {
  const lower = file.name.toLowerCase();
  if (!ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return "PDF or DOCX only";
  }
  if (file.size > MAX_FILE_BYTES) {
    return `Exceeds the ${Math.round(MAX_FILE_BYTES / 1_000_000)} MB limit`;
  }
  return null;
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

export function CvUploadPanel({ jobId, onUploaded }: CvUploadPanelProps) {
  const [pending, setPending] = useState<File[]>([]);
  const [rejects, setRejects] = useState<RejectedFile[]>([]);
  const [failures, setFailures] = useState<CandidateResult[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queuedCount, setQueuedCount] = useState<number | null>(null);

  const overLimit = pending.length > MAX_BATCH_FILES;

  const onFilesSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    setError(null);
    setQueuedCount(null);
    const accepted: File[] = [];
    const rejected: RejectedFile[] = [];
    for (const file of files) {
      const reason = describeRejection(file);
      if (reason) rejected.push({ name: file.name, reason });
      else accepted.push(file);
    }
    setPending((prev) => [...prev, ...accepted]);
    setRejects((prev) => [...prev, ...rejected]);
  };

  const removePending = (index: number) =>
    setPending((prev) => prev.filter((_, i) => i !== index));

  const upload = async () => {
    if (pending.length === 0 || overLimit || uploading) return;
    setUploading(true);
    setError(null);
    setFailures([]);
    try {
      const result = await uploadCvs(jobId, pending);
      setFailures(
        result.candidates.filter((c) => c.status === "failed"),
      );
      setQueuedCount(result.total_count -
        result.candidates.filter((c) => c.status === "failed").length);
      setPending([]);
      onUploaded?.(result);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Upload failed — try again.",
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload CVs</CardTitle>
        <CardDescription>
          PDF or DOCX, up to {MAX_BATCH_FILES} files per batch. Filenames stay
          local to this screen; the evaluator never sees them.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cv-files">CV files</Label>
          <label
            htmlFor="cv-files"
            className="flex cursor-pointer flex-col items-center gap-1 rounded-md border border-dashed px-4 py-5 text-center text-xs text-muted-foreground transition-colors hover:bg-accent focus-within:ring-2 focus-within:ring-ring"
          >
            <FileUp className="size-5" aria-hidden />
            <span>
              Drop CV files here or{" "}
              <span className="font-medium text-foreground underline">
                browse
              </span>
            </span>
            <input
              id="cv-files"
              type="file"
              multiple
              accept=".pdf,.docx"
              className="sr-only"
              onChange={onFilesSelected}
              disabled={uploading}
            />
          </label>
        </div>

        {overLimit && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>Too many files</AlertTitle>
            <AlertDescription>
              Batches are limited to {MAX_BATCH_FILES} files — remove{" "}
              {pending.length - MAX_BATCH_FILES} to continue.
            </AlertDescription>
          </Alert>
        )}

        {pending.length > 0 && (
          <ul className="flex flex-col gap-1" aria-label="Files ready to upload">
            {pending.map((file, index) => (
              <li
                key={`${file.name}-${index}`}
                className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs"
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <span className="text-muted-foreground tabular-nums">
                  {formatSize(file.size)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => removePending(index)}
                  disabled={uploading}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        )}

        {rejects.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium">Skipped before upload</p>
            <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              {rejects.map((reject, index) => (
                <li
                  key={`${reject.name}-${index}`}
                  className="flex items-baseline gap-2"
                >
                  <span className="truncate">{reject.name}</span>
                  <Badge variant="outline">{reject.reason}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}

        {failures.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-xs font-medium text-destructive">
              Couldn’t process
            </p>
            <ul className="flex flex-col gap-0.5 text-xs">
              {failures.map((failure) => (
                <li key={failure.id} className="flex flex-col">
                  <span className="truncate font-medium">
                    {failure.filename}
                  </span>
                  <span className="text-muted-foreground">
                    {failure.error_message ?? "Processing failed"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>Upload failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex items-center gap-3">
          <Button
            onClick={upload}
            disabled={pending.length === 0 || overLimit || uploading}
          >
            {uploading
              ? "Uploading…"
              : pending.length === 0
                ? "Upload files"
                : `Upload ${pending.length} file${pending.length === 1 ? "" : "s"}`}
          </Button>
          <span aria-live="polite" className="text-xs text-muted-foreground">
            {queuedCount !== null &&
              `${queuedCount} queued for screening`}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

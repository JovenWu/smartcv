import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BatchUploadResponse } from "@/types";
import { MAX_BATCH_FILES } from "@/types";
import { CvUploadPanel } from "./CvUploadPanel";

function pdf(name: string, size = 512): File {
  return new File([new Uint8Array(size)], name, { type: "application/pdf" });
}

function jsonResponse(payload: unknown, status = 201): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function uploadResponse(names: string[]): BatchUploadResponse {
  return {
    candidates: names.map((name, i) => ({
      id: `cand-${i}`,
      filename: name,
      upload_order: i,
      status: "queued" as const,
      evaluations: [],
      total_score: null,
      error_message: null,
      retryable: false,
    })),
    total_count: names.length,
  };
}

async function selectFiles(
  user: ReturnType<typeof userEvent.setup>,
  files: File[],
) {
  const input = screen.getByLabelText(/cv files/i);
  await user.upload(input, files);
}

describe("CvUploadPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads pdf and docx files via multipart FormData", async () => {
    const user = userEvent.setup();
    const onUploaded = vi.fn();
    const files = [pdf("alice.pdf"), pdf("bob.docx")];
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(uploadResponse(["alice.pdf", "bob.docx"])),
    );

    render(<CvUploadPanel jobId="job-1" onUploaded={onUploaded} />);
    await selectFiles(user, files);
    await user.click(screen.getByRole("button", { name: /upload 2 files/i }));

    await waitFor(() => expect(onUploaded).toHaveBeenCalled());
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/jobs/job-1/cvs");
    expect(init?.method).toBe("POST");
    const form = init?.body as FormData;
    expect(form.getAll("files").map((f) => (f as File).name)).toEqual([
      "alice.pdf",
      "bob.docx",
    ]);
    expect(await screen.findByText(/2 queued/i)).toBeInTheDocument();
  });

  it("rejects unsupported types locally and never calls the backend", async () => {
    // applyAccept: false simulates a drag-drop or programmatic selection,
    // which bypasses the input's accept filter.
    const user = userEvent.setup({ applyAccept: false });
    render(<CvUploadPanel jobId="job-1" />);
    await selectFiles(user, [new File(["x"], "notes.txt")]);

    expect(await screen.findByText(/notes\.txt/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /upload/i }),
    ).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uploads only the valid files from a mixed selection", async () => {
    const user = userEvent.setup({ applyAccept: false });
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(uploadResponse(["good.pdf"])),
    );
    render(<CvUploadPanel jobId="job-1" />);
    await selectFiles(user, [pdf("good.pdf"), new File(["x"], "bad.exe")]);

    await user.click(screen.getByRole("button", { name: /upload 1 file/i }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const form = vi.mocked(fetch).mock.calls[0][1]?.body as FormData;
    expect(form.getAll("files")).toHaveLength(1);
    expect(await screen.findByText(/bad\.exe/)).toBeInTheDocument();
  });

  it("refuses batches over the 200 file limit", async () => {
    const user = userEvent.setup();
    const files = Array.from({ length: MAX_BATCH_FILES + 1 }, (_, i) =>
      pdf(`cv-${i}.pdf`),
    );
    render(<CvUploadPanel jobId="job-1" />);
    await selectFiles(user, files);

    expect(await screen.findByRole("alert")).toHaveTextContent(/200/);
    expect(
      screen.getByRole("button", { name: /upload/i }),
    ).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows server per-file failures without losing the queued ones", async () => {
    const user = userEvent.setup();
    const response: BatchUploadResponse = {
      candidates: [
        {
          id: "c1",
          filename: "ok.pdf",
          upload_order: 0,
          status: "queued",
          evaluations: [],
          total_score: null,
          error_message: null,
          retryable: false,
        },
        {
          id: "c2",
          filename: "corrupt.pdf",
          upload_order: 1,
          status: "failed",
          evaluations: [],
          total_score: null,
          error_message: "Not a valid PDF document",
          retryable: false,
        },
      ],
      total_count: 2,
    };
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(response));

    render(<CvUploadPanel jobId="job-1" />);
    await selectFiles(user, [pdf("ok.pdf"), pdf("corrupt.pdf")]);
    await user.click(screen.getByRole("button", { name: /upload 2 files/i }));

    expect(await screen.findByText(/corrupt\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/not a valid pdf/i)).toBeInTheDocument();
    expect(screen.getByText(/1 queued/i)).toBeInTheDocument();
  });

  it("surfaces upload-level errors accessibly", async () => {
    const user = userEvent.setup();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ detail: "Batch exceeds limit" }, 413),
    );
    render(<CvUploadPanel jobId="job-1" />);
    await selectFiles(user, [pdf("one.pdf")]);
    await user.click(screen.getByRole("button", { name: /upload 1 file/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /batch exceeds limit/i,
    );
  });
});

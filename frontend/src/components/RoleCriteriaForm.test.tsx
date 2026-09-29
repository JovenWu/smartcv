import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobSnapshot } from "@/types";
import { RoleCriteriaForm } from "./RoleCriteriaForm";

const jobSnapshot: JobSnapshot = {
  id: "job-1",
  title: "Backend Engineer",
  criteria: [
    {
      id: "criterion-1",
      name: "Python",
      description: "",
      weight: 4,
    },
  ],
  candidates: [],
  completed_count: 0,
  total_count: 0,
  is_final: false,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fillCriterion(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  const nameInput = await screen.findByLabelText(/criterion name/i);
  await user.type(nameInput, name);
}

async function fillWeight(
  user: ReturnType<typeof userEvent.setup>,
  value: string,
) {
  const weightInput = screen.getByLabelText(/weight \(1–5\)/i);
  await user.clear(weightInput);
  await user.type(weightInput, value);
}

describe("RoleCriteriaForm", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires a title and at least one named criterion", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<RoleCriteriaForm onJobCreated={onCreated} />);

    await user.click(
      screen.getByRole("button", { name: /confirm weights/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/title/i);
    expect(fetch).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("requests suggestions, marks them as proposals, and creates the job on confirm", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          suggestions: [
            {
              criterion_id: "criterion-1",
              proposed_weight: 4,
              confidence: 0.82,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(jobSnapshot, 201));

    render(<RoleCriteriaForm onJobCreated={onCreated} />);
    await user.type(screen.getByLabelText(/role title/i), "Backend Engineer");
    await fillCriterion(user, "Python");

    await user.click(
      screen.getByRole("button", { name: /suggest weights/i }),
    );

    const weightInput = await screen.findByLabelText(/weight \(1–5\)/i);
    await waitFor(() => expect(weightInput).toHaveValue(4));
    expect(screen.getByText(/82%/)).toBeInTheDocument();

    const [suggestUrl, suggestInit] = fetchMock.mock.calls[0];
    expect(suggestUrl).toBe("/api/weight-suggestions");
    expect(JSON.parse(suggestInit?.body as string)).toEqual({
      criteria: [{ id: "criterion-1", name: "Python", description: "" }],
    });

    await user.click(
      screen.getByRole("button", { name: /confirm weights/i }),
    );

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(jobSnapshot));
    const [createUrl, createInit] = fetchMock.mock.calls[1];
    expect(createUrl).toBe("/api/jobs");
    expect(JSON.parse(createInit?.body as string)).toEqual({
      title: "Backend Engineer",
      criteria: [
        { id: "criterion-1", name: "Python", description: "", weight: 4 },
      ],
    });
  });

  it("does not create a job before explicit confirmation", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        suggestions: [
          { criterion_id: "criterion-1", proposed_weight: 3, confidence: 0.6 },
        ],
      }),
    );
    render(<RoleCriteriaForm onJobCreated={vi.fn()} />);
    await user.type(screen.getByLabelText(/role title/i), "Analyst");
    await fillCriterion(user, "SQL");
    await user.click(
      screen.getByRole("button", { name: /suggest weights/i }),
    );
    await screen.findByText(/60%/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets the recruiter set weights manually when suggestions fail", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(jsonResponse(jobSnapshot, 201));

    render(<RoleCriteriaForm onJobCreated={onCreated} />);
    await user.type(screen.getByLabelText(/role title/i), "Backend Engineer");
    await fillCriterion(user, "Python");

    await user.click(
      screen.getByRole("button", { name: /suggest weights/i }),
    );
    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent(/manually/i);

    await fillWeight(user, "5");
    await user.click(
      screen.getByRole("button", { name: /confirm weights/i }),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("rejects weights outside 1–5", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    render(<RoleCriteriaForm onJobCreated={onCreated} />);
    await user.type(screen.getByLabelText(/role title/i), "Backend Engineer");
    await fillCriterion(user, "Python");
    await fillWeight(user, "9");

    await user.click(
      screen.getByRole("button", { name: /confirm weights/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /between 1 and 5/i,
    );
    expect(screen.getByLabelText(/weight \(1–5\)/i)).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("supports adding and removing criteria", async () => {
    const user = userEvent.setup();
    render(<RoleCriteriaForm onJobCreated={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /add criterion/i }));
    expect(screen.getAllByLabelText(/criterion name/i)).toHaveLength(2);

    await user.click(
      screen.getAllByRole("button", { name: /remove criterion/i })[0],
    );
    expect(screen.getAllByLabelText(/criterion name/i)).toHaveLength(1);
  });
});

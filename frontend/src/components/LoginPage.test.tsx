import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts credentials and reports success", async () => {
    const user = userEvent.setup();
    const onAuthenticated = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );

    render(<LoginPage onAuthenticated={onAuthenticated} />);
    await user.type(screen.getByLabelText(/username/i), "recruiter");
    await user.type(screen.getByLabelText(/password/i), "s3cret");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith("recruiter"));
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/auth/login");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      username: "recruiter",
      password: "s3cret",
    });
  });

  it("shows an accessible error on invalid credentials", async () => {
    const user = userEvent.setup();
    const onAuthenticated = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({ detail: "Invalid username or password" }, 401),
    );

    render(<LoginPage onAuthenticated={onAuthenticated} />);
    await user.type(screen.getByLabelText(/username/i), "recruiter");
    await user.type(screen.getByLabelText(/password/i), "nope");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /invalid username or password/i,
    );
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it("requires both fields", async () => {
    const user = userEvent.setup();
    render(<LoginPage onAuthenticated={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    expect(fetch).not.toHaveBeenCalled();
  });
});

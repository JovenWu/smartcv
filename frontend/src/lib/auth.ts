export interface SessionInfo {
  auth_required: boolean
  authenticated: boolean
  username: string | null
}

async function parseError(response: Response): Promise<Error> {
  let detail = `Request failed (${response.status})`
  try {
    const body = (await response.json()) as { detail?: unknown }
    if (typeof body.detail === "string") detail = body.detail
  } catch {
    // Non-JSON body — keep the status-based message.
  }
  return new Error(detail)
}

export async function login(
  username: string,
  password: string,
): Promise<void> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  })
  if (!response.ok) throw await parseError(response)
}

export async function logout(): Promise<void> {
  const response = await fetch("/api/auth/logout", { method: "POST" })
  if (!response.ok) throw await parseError(response)
}

export async function getSession(): Promise<SessionInfo> {
  const response = await fetch("/api/auth/session")
  if (!response.ok) throw await parseError(response)
  return (await response.json()) as SessionInfo
}

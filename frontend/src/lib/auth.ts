export interface SessionInfo {
  auth_required: boolean
  authenticated: boolean
  username: string | null
  is_admin: boolean
}

async function parseError(response: Response): Promise<Error> {
  let detail = `Request failed (${response.status})`
  try {
    const body = (await response.json()) as { detail?: unknown }
    if (typeof body.detail === "string") detail = body.detail
  } catch {
  }
  return new Error(detail)
}

export async function getSession(): Promise<SessionInfo> {
  const response = await fetch("/api/auth/session")
  if (!response.ok) throw await parseError(response)
  return (await response.json()) as SessionInfo
}

const UNAUTHENTICATED: SessionInfo = {
  auth_required: true,
  authenticated: false,
  username: null,
  is_admin: false,
}

let session: SessionInfo | null = null
let loaded = false
let inflight: Promise<SessionInfo> | null = null

const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((l) => l())
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener)
  if (!loaded) void refreshSession()
  return () => {
    listeners.delete(listener)
  }
}

/** Null until the first session check resolves — the loading state. */
export function getSessionSnapshot(): SessionInfo | null {
  return session
}

/**
 * Fetch /api/auth/session once for all consumers. A failed check resolves
 * to the signed-out state so guards redirect instead of spinning forever.
 */
export function refreshSession(): Promise<SessionInfo> {
  inflight ??= getSession()
    .then((info) => {
      session = info
      loaded = true
      emit()
      return info
    })
    .catch(() => {
      session = UNAUTHENTICATED
      loaded = true
      emit()
      return session
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function clearSession(): void {
  session = UNAUTHENTICATED
  loaded = true
  emit()
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
  await refreshSession()
}

export async function logout(): Promise<void> {
  const response = await fetch("/api/auth/logout", { method: "POST" })
  if (!response.ok) throw await parseError(response)
  clearSession()
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const response = await fetch("/api/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
    }),
  })
  if (!response.ok) throw await parseError(response)
}

export function __resetSessionForTests() {
  session = null
  loaded = false
  inflight = null
}

import { useEffect, useState } from "react"

import { getSession, type SessionInfo } from "@/lib/auth"

/** Returns the current session, or null while the first check is in flight. */
export function useSession(): SessionInfo | null {
  const [session, setSession] = useState<SessionInfo | null>(null)

  useEffect(() => {
    let active = true
    getSession()
      .then((s) => {
        if (active) setSession(s)
      })
      .catch(() => {
        if (active) {
          setSession({
            auth_required: true,
            authenticated: false,
            username: null,
          })
        }
      })
    return () => {
      active = false
    }
  }, [])

  return session
}

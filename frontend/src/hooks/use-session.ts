import { useSyncExternalStore } from "react"

import {
  getSessionSnapshot,
  subscribeSession,
  type SessionInfo,
} from "@/lib/auth"

export { refreshSession } from "@/lib/auth"

/** Returns the current session, or null while the first check is in flight. */
export function useSession(): SessionInfo | null {
  return useSyncExternalStore(subscribeSession, getSessionSnapshot)
}

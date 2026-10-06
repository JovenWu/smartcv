import { Navigate, Outlet } from "react-router-dom"

import { useSession } from "@/hooks/use-session"

/**
 * Admin-only route guard — redirects non-admins to /. Rendered inside
 * RequireAuth, so the session is already resolved and authenticated here.
 */
export function RequireAdmin() {
  const session = useSession()
  if (!session) return null
  if (!session.is_admin) return <Navigate to="/" replace />
  return <Outlet />
}

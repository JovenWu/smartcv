import { Loader2Icon } from "lucide-react"
import { Navigate, Outlet } from "react-router-dom"

import { useSession } from "@/hooks/use-session"

export function RequireAuth() {
  const session = useSession()

  if (!session) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!session.authenticated) {
    return <Navigate to="/login" replace />
  }

  return <Outlet />
}

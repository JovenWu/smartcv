import { Loader2Icon } from "lucide-react"
import { Navigate } from "react-router-dom"

import { LoginForm } from "@/components/login-form"
import { useSession } from "@/hooks/use-session"

export default function LoginPage() {
  const session = useSession()

  if (!session) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (session.authenticated) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <LoginForm />
      </div>
    </div>
  )
}

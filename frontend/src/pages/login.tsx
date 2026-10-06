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
    <div className="grid min-h-svh lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          <a
            href="#"
            className="flex items-center gap-2 font-medium"
            onClick={(e) => e.preventDefault()}
          >
            <img
              src="/app-icon-v2.png"
              alt=""
              className="size-7 rounded-md"
            />
            SmartCV
          </a>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-xs">
            <LoginForm />
          </div>
        </div>
      </div>
      <div className="relative hidden bg-[#fff8df] lg:block">
        <img
          src="/login-cover-v2.webp"
          alt="Why Still"
          className="absolute inset-0 h-full w-full object-cover dark:brightness-[0.2] dark:grayscale"
        />
      </div>
    </div>
  )
}

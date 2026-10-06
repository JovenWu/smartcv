import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
  type Params,
} from "react-router-dom"

import { RequireAdmin } from "@/components/require-admin"
import { RequireAuth } from "@/components/require-auth"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppLayout } from "@/layouts/app-layout"
import { getOpening } from "@/lib/openings"
import LoginPage from "@/pages/login"
import OpeningDetailPage from "@/pages/opening-detail"
import OpeningsPage from "@/pages/openings"
import UsersPage from "@/pages/users"

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          {
            path: "/",
            element: <OpeningsPage />,
            handle: { crumbs: [{ label: "Openings" }] },
          },
          {
            element: <RequireAdmin />,
            children: [
              {
                path: "/users",
                element: <UsersPage />,
                handle: { crumbs: [{ label: "Users" }] },
              },
            ],
          },
          {
            path: "/openings/:id",
            element: <OpeningDetailPage />,
            handle: {
              action: "editOpening",
              crumbs: [
                { label: "Openings", to: "/" },
                {
                  label: (params: Params) =>
                    getOpening(params.id)?.title ?? "Opening",
                },
              ],
            },
          },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
])

export default function App() {
  return (
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>
  )
}

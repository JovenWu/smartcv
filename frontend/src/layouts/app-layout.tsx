import { Fragment, useState } from "react"
import { PencilIcon, PlusIcon } from "lucide-react"
import {
  Link,
  Outlet,
  useMatches,
  type Params,
} from "react-router-dom"

import { AppSidebar } from "@/components/app-sidebar"
import {
  CvViewerLayout,
  CvViewerProvider,
} from "@/components/cv-viewer"
import { EditOpeningDialog } from "@/components/edit-opening-dialog"
import { NewOpeningDialog } from "@/components/new-opening-dialog"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { useSession } from "@/hooks/use-session"

interface Crumb {
  label: string | ((params: Params) => string)
  to?: string
}

interface RouteHandle {
  crumbs?: Crumb[]
  action?: "editOpening"
}

export function AppLayout() {
  const session = useSession()
  const matches = useMatches()
  const [newOpeningOpen, setNewOpeningOpen] = useState(false)
  const [editOpeningOpen, setEditOpeningOpen] = useState(false)

  const match = [...matches]
    .reverse()
    .find((m) => (m.handle as RouteHandle | undefined)?.crumbs)
  const crumbs =
    (match?.handle as RouteHandle | undefined)?.crumbs ?? [
      { label: "Openings" },
    ]
  const action = (match?.handle as RouteHandle | undefined)?.action
  const openingId = match?.params.id

  return (
    <SidebarProvider>
      <CvViewerProvider>
        <AppSidebar
        user={{
          name: session?.username ?? "Account",
          email: "",
          avatar: "",
        }}
      />
      <CvViewerLayout>
        <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2">
          <div className="flex w-full items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-vertical:h-4 data-vertical:self-auto"
            />
            <Breadcrumb>
              <BreadcrumbList>
                {crumbs.map((crumb, i) => {
                  const label =
                    typeof crumb.label === "function"
                      ? crumb.label(match?.params ?? {})
                      : crumb.label
                  const last = i === crumbs.length - 1
                  return (
                    <Fragment key={`${i}-${typeof label === "string" ? label : i}`}>
                      {i > 0 && (
                        <BreadcrumbSeparator className="hidden md:block" />
                      )}
                      <BreadcrumbItem className={last ? "" : "hidden md:block"}>
                        {last || !crumb.to ? (
                          <BreadcrumbPage>{label}</BreadcrumbPage>
                        ) : (
                          <BreadcrumbLink asChild>
                            <Link to={crumb.to}>{label}</Link>
                          </BreadcrumbLink>
                        )}
                      </BreadcrumbItem>
                    </Fragment>
                  )
                })}
              </BreadcrumbList>
            </Breadcrumb>
            {action === "editOpening" && openingId ? (
              <Button
                size="sm"
                variant="outline"
                aria-label="Edit opening"
                className="ml-auto w-8 px-0 md:w-auto md:px-3"
                onClick={() => setEditOpeningOpen(true)}
              >
                <PencilIcon />
                <span className="hidden md:inline">Edit opening</span>
              </Button>
            ) : (
              <Button
                size="sm"
                aria-label="New opening"
                className="ml-auto w-8 px-0 md:w-auto md:px-3"
                onClick={() => setNewOpeningOpen(true)}
              >
                <PlusIcon />
                <span className="hidden md:inline">New opening</span>
              </Button>
            )}
          </div>
        </header>
        <Outlet />
        <NewOpeningDialog
          open={newOpeningOpen}
          onOpenChange={setNewOpeningOpen}
        />
        <EditOpeningDialog
          openingId={openingId}
          open={editOpeningOpen}
          onOpenChange={setEditOpeningOpen}
        />
          </SidebarInset>
        </CvViewerLayout>
      </CvViewerProvider>
    </SidebarProvider>
  )
}

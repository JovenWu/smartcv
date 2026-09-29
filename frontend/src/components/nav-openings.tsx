import { useState } from "react"
import { Link, useLocation } from "react-router-dom"
import { PlusIcon, RotateCcwIcon } from "lucide-react"

import { NewOpeningDialog } from "@/components/new-opening-dialog"
import {
  refreshOpenings,
  useOpeningsStatus,
  type Opening,
} from "@/lib/openings"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar"

export function NavOpenings({ items }: { items: Opening[] }) {
  const location = useLocation()
  const status = useOpeningsStatus()
  const [newOpeningOpen, setNewOpeningOpen] = useState(false)

  return (
    <SidebarGroup>
      <SidebarGroupLabel asChild>
        <Link
          to="/"
          className="cursor-pointer transition-colors hover:text-sidebar-foreground"
        >
          Openings
        </Link>
      </SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {status === "loading" && (
            <>
              <SidebarMenuSkeleton showIcon />
              <SidebarMenuSkeleton showIcon />
            </>
          )}
          {status === "error" && (
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => refreshOpenings().catch(() => {})}
                className="border border-dashed text-muted-foreground"
              >
                <RotateCcwIcon />
                <span>Retry loading</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          {status === "ready" && items.length === 0 && (
            <>
              <p className="px-2 pb-1 text-xs text-muted-foreground">
                No openings yet
              </p>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => setNewOpeningOpen(true)}
                  className="border border-dashed text-muted-foreground hover:text-sidebar-foreground"
                >
                  <PlusIcon />
                  <span>New opening</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </>
          )}
          {status === "ready" &&
            items.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  asChild
                  isActive={location.pathname === item.url}
                >
                  <Link to={item.url}>
                    {item.icon}
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
                {item.pendingReview > 0 && (
                  <SidebarMenuBadge className="rounded-full bg-muted">
                    {item.pendingReview}
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            ))}
        </SidebarMenu>
      </SidebarGroupContent>
      <NewOpeningDialog
        open={newOpeningOpen}
        onOpenChange={setNewOpeningOpen}
      />
    </SidebarGroup>
  )
}

import { Link, useLocation } from "react-router-dom"

import type { Opening } from "@/lib/openings"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export function NavOpenings({ items }: { items: Opening[] }) {
  const location = useLocation()

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
          {items.map((item) => (
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
    </SidebarGroup>
  )
}

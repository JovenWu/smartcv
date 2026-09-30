import { useState } from "react"
import { Link, useLocation } from "react-router-dom"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  EllipsisIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { NewOpeningDialog } from "@/components/new-opening-dialog"
import {
  refreshOpenings,
  removeOpening,
  setOpeningArchived,
  useOpeningsStatus,
  type Opening,
} from "@/lib/openings"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

function NavOpeningItem({ item, active }: { item: Opening; active: boolean }) {
  const { isMobile } = useSidebar()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const archived = item.status === "archived"

  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuButton asChild isActive={active}>
            <Link to={item.url}>
              {item.icon}
              <span>{item.title}</span>
            </Link>
          </SidebarMenuButton>
        </TooltipTrigger>
        <TooltipContent side="right">{item.title}</TooltipContent>
      </Tooltip>
      {item.pendingReview > 0 && (
        // Badge shares the right edge with the hover action — shift it
        // left of the slot the button's `has-menu-action` padding reserves.
        <SidebarMenuBadge className="right-8 rounded-full bg-muted">
          {item.pendingReview}
        </SidebarMenuBadge>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            showOnHover
            aria-label={`Actions for ${item.title}`}
          >
            <EllipsisIcon />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={isMobile ? "bottom" : "right"}
          align="start"
        >
          <DropdownMenuItem
            onSelect={() =>
              setOpeningArchived(item.id, !archived).catch(() => {})
            }
          >
            {archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
            {archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDeleteOpen(true)}
          >
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete opening?"
        description={`"${item.title}" and all its candidates, scores, and evidence will be permanently removed. This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => removeOpening(item.id)}
      />
    </SidebarMenuItem>
  )
}

export function NavOpenings({ items }: { items: Opening[] }) {
  const location = useLocation()
  const status = useOpeningsStatus()
  const [newOpeningOpen, setNewOpeningOpen] = useState(false)
  // Archived openings never appear in the sidebar.
  const visible = items.filter((item) => item.status !== "archived")

  return (
    <SidebarGroup>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarGroupLabel asChild>
            <Link
              to="/"
              className="cursor-pointer transition-colors hover:text-sidebar-foreground"
            >
              Openings
            </Link>
          </SidebarGroupLabel>
        </TooltipTrigger>
        <TooltipContent side="right">All openings</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarGroupAction
            aria-label="New opening"
            onClick={() => setNewOpeningOpen(true)}
          >
            <PlusIcon />
          </SidebarGroupAction>
        </TooltipTrigger>
        <TooltipContent side="right">New opening</TooltipContent>
      </Tooltip>
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
          {status === "ready" && visible.length === 0 && (
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
            visible.map((item) => (
              <NavOpeningItem
                key={item.id}
                item={item}
                active={location.pathname === item.url}
              />
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

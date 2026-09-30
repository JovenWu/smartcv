import { useEffect, useRef, useState, type ReactNode } from "react"
import { FileTextIcon, XIcon } from "lucide-react"
import { cn } from "cn"

import {
  CvViewerContext,
  useCvViewer,
  type CvViewer,
} from "@/components/cv-viewer-context"
import type { Candidate } from "@/types"
import { Button } from "@/components/ui/button"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { useSidebar } from "@/components/ui/sidebar"

function canPreview(file: Candidate["file"]): boolean {
  if (!file.url || file.url === "#") return false
  return (
    file.mimeType === "application/pdf" || file.mimeType.startsWith("image/")
  )
}

function CvPreview({ candidate }: { candidate: Candidate }) {
  const { file } = candidate
  if (canPreview(file)) {
    return file.mimeType === "application/pdf" ? (
      <iframe
        src={file.url}
        title={`CV of ${candidate.name}`}
        className="h-full w-full"
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    ) : (
      <img
        src={file.url}
        alt={`CV of ${candidate.name}`}
        className="h-full w-full object-contain"
      />
    )
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-muted/30 p-6 text-center">
      <div className="flex w-40 flex-col gap-2 rounded-md border bg-background p-4 shadow-xs">
        <div className="h-2 w-2/3 rounded bg-muted" />
        <div className="h-1.5 w-full rounded bg-muted" />
        <div className="h-1.5 w-full rounded bg-muted" />
        <div className="h-1.5 w-4/5 rounded bg-muted" />
        <div className="mt-2 h-1.5 w-full rounded bg-muted" />
        <div className="h-1.5 w-3/5 rounded bg-muted" />
      </div>
      <p className="text-xs text-muted-foreground">
        Preview will render here once files are served.
      </p>
    </div>
  )
}

function CvViewerPanel({
  candidate,
  onClose,
}: {
  candidate: Candidate
  onClose: () => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">{candidate.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {candidate.file.filename}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close CV"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <CvPreview candidate={candidate} />
      </div>
    </div>
  )
}

export function CvViewerProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Candidate | null>(null)
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar()
  // Pending restore of the user's sidebar state, run when the viewer
  // closes. Kept in a ref rather than an effect dep: setOpen's identity
  // changes on every sidebar toggle, so a cleanup keyed on it would fire
  // mid-session and snap the sidebar back to its pre-viewer state.
  const restoreSidebar = useRef<(() => void) | null>(null)

  const openCv = (candidate: Candidate) => {
    if (!restoreSidebar.current) {
      const prevOpen = sidebarOpen
      restoreSidebar.current = () => setSidebarOpen(prevOpen)
      setSidebarOpen(false)
    }
    setSelected(candidate)
  }

  const closeCv = () => {
    setSelected(null)
    restoreSidebar.current?.()
    restoreSidebar.current = null
  }

  useEffect(() => () => restoreSidebar.current?.(), [])

  const value: CvViewer = { selected, openCv, closeCv }

  return (
    <CvViewerContext.Provider value={value}>
      {children}
    </CvViewerContext.Provider>
  )
}

/**
 * Renders the app content beside a resizable CV panel (overlay on mobile).
 * The panel group and the main panel stay mounted whether or not a CV is
 * selected — only the handle/second panel (or the mobile overlay) toggle.
 * Switching the wrapper element by state would remount the whole page tree.
 */
export function CvViewerLayout({ children }: { children: ReactNode }) {
  const { selected, closeCv } = useCvViewer()
  const { isMobile, state: sidebarState } = useSidebar()

  return (
    <>
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-w-0 flex-1"
      >
        {/* Padding lives on the panel, not the frame: the library wraps
            panel children in an internal scroll region where a margin
            inflates scrollHeight and yields a phantom page scrollbar. */}
        <ResizablePanel
          minSize="30%"
          className={cn(
            "md:p-2",
            sidebarState === "collapsed" ? "" : "md:pl-0",
          )}
        >
          <div className="flex h-full min-h-0 min-w-0 flex-col bg-background md:overflow-hidden md:rounded-xl md:shadow-sm">
            {children}
          </div>
        </ResizablePanel>
        {selected && !isMobile && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="37%" minSize="20%" maxSize="60%">
              <CvViewerPanel candidate={selected} onClose={closeCv} />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      {selected && isMobile && (
        <div className="fixed inset-0 z-40">
          <CvViewerPanel candidate={selected} onClose={closeCv} />
        </div>
      )}
    </>
  )
}

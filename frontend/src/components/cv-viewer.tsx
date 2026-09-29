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
  const prevSidebarOpen = useRef(true)
  const collapsedByViewer = useRef(false)

  const openCv = (candidate: Candidate) => {
    if (!collapsedByViewer.current) {
      prevSidebarOpen.current = sidebarOpen
      collapsedByViewer.current = true
      setSidebarOpen(false)
    }
    setSelected(candidate)
  }

  const closeCv = () => {
    setSelected(null)
    if (collapsedByViewer.current) {
      collapsedByViewer.current = false
      setSidebarOpen(prevSidebarOpen.current)
    }
  }

  useEffect(
    () => () => {
      if (collapsedByViewer.current) setSidebarOpen(prevSidebarOpen.current)
    },
    [setSidebarOpen],
  )

  const value: CvViewer = { selected, openCv, closeCv }

  return (
    <CvViewerContext.Provider value={value}>
      {children}
    </CvViewerContext.Provider>
  )
}

/** Renders the app content beside a resizable CV panel (overlay on mobile). */
export function CvViewerLayout({ children }: { children: ReactNode }) {
  const { selected, closeCv } = useCvViewer()
  const { isMobile, state: sidebarState } = useSidebar()

  if (!selected) return <>{children}</>

  if (isMobile) {
    return (
      <>
        {children}
        <div className="fixed inset-0 z-40">
          <CvViewerPanel candidate={selected} onClose={closeCv} />
        </div>
      </>
    )
  }

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="min-w-0 flex-1"
    >
      <ResizablePanel minSize="30%">
        {/* peer-* inset styling doesn't reach inside a panel — replicate the frame */}
        <div
          className={cn(
            "flex h-full min-w-0 flex-col bg-background md:m-2 md:overflow-hidden md:rounded-xl md:shadow-sm",
            sidebarState === "collapsed" ? "md:ml-2" : "md:ml-0",
          )}
        >
          {children}
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize="28%" minSize="20%" maxSize="60%">
        <CvViewerPanel candidate={selected} onClose={closeCv} />
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

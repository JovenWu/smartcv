import { useRef, useState } from "react"
import {
  ArrowRightIcon,
  ChevronLeftIcon,
  FileUpIcon,
  PenLineIcon,
} from "lucide-react"
import { useNavigate } from "react-router-dom"

import { ImportOpeningForm } from "@/components/import-opening-form"
import { ManualOpeningForm } from "@/components/manual-opening-form"
import {
  addOpening,
  type NewOpeningInput,
  type Opening,
} from "@/lib/openings"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"

type View = "choose" | "import" | "review" | "manual"

const VIEW_TITLE: Record<View, string> = {
  choose: "New opening",
  import: "Import a listing",
  review: "Review imported details",
  manual: "Enter it manually",
}

const VIEW_DESCRIPTION: Record<View, string> = {
  choose: "Import a listing or type the role details yourself.",
  import: "We read the job ad and fill in the opening for you.",
  review: "We filled in what we found — check it and complete the rest.",
  manual: "Add a role to screen candidates against.",
}

function Choice({
  icon,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex h-full flex-col items-start gap-3 rounded-xl border bg-card p-5 text-left shadow-xs transition-colors hover:border-foreground/20 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex w-full items-start justify-between">
        <div className="flex size-10 items-center justify-center rounded-lg border bg-muted text-muted-foreground [&>svg]:size-5">
          {icon}
        </div>
        <ArrowRightIcon className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
    </button>
  )
}

export function NewOpeningDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const [view, setView] = useState<View>("choose")
  const [draft, setDraft] = useState<Partial<NewOpeningInput>>()
  const createdRef = useRef<Opening | null>(null)

  const handleOpenChange = (next: boolean) => {
    if (next) {
      setView("choose")
      setDraft(undefined)
      createdRef.current = null
    }
    onOpenChange(next)
  }

  const createOpening = async (input: NewOpeningInput) => {
    createdRef.current = await addOpening(input)
  }

  const done = () => {
    onOpenChange(false)
    const created = createdRef.current
    createdRef.current = null
    navigate(created ? created.url : "/")
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-1">
            {view !== "choose" && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="-ml-1"
                onClick={() =>
                  setView(view === "review" ? "import" : "choose")
                }
                aria-label="Back"
              >
                <ChevronLeftIcon />
              </Button>
            )}
            <DialogTitle>{VIEW_TITLE[view]}</DialogTitle>
          </div>
          <DialogDescription>{VIEW_DESCRIPTION[view]}</DialogDescription>
        </DialogHeader>

        {view === "choose" && (
          <div className="grid gap-4 sm:grid-cols-[1fr_auto_1fr]">
            <Choice
              icon={<FileUpIcon />}
              title="Import a listing"
              description="Paste a Jobstreet or LinkedIn link, or drop a PDF or image of the job ad."
              onClick={() => setView("import")}
            />
            <Separator
              orientation="vertical"
              className="hidden self-stretch sm:block"
            />
            <Separator orientation="horizontal" className="sm:hidden" />
            <Choice
              icon={<PenLineIcon />}
              title="Enter it manually"
              description="Type the role details and screening criteria yourself."
              onClick={() => setView("manual")}
            />
          </div>
        )}
        {view === "import" && (
          <ImportOpeningForm
            onExtracted={(extracted) => {
              setDraft(extracted)
              setView("review")
            }}
          />
        )}
        {view === "review" && (
          <ManualOpeningForm
            key="review"
            initial={draft}
            onSubmit={createOpening}
            onDone={done}
          />
        )}
        {view === "manual" && (
          <ManualOpeningForm
            key="manual"
            onSubmit={createOpening}
            onDone={done}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

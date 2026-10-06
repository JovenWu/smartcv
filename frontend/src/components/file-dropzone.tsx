import { useRef, useState } from "react"
import { FileUpIcon } from "lucide-react"
import { cn } from "cn"

function matchesAccept(file: File, accept?: string): boolean {
  if (!accept) return true
  const name = file.name.toLowerCase()
  const type = file.type.toLowerCase()
  return accept
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .some((token) => {
      if (token === "*" || token === "*/*") return true
      if (token.startsWith(".")) return name.endsWith(token)
      if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1))
      return type === token
    })
}

export function FileDropzone({
  accept,
  multiple,
  title,
  hint,
  busy = false,
  onFiles,
  className,
}: {
  accept?: string
  multiple?: boolean
  title: string
  hint?: string
  /** Disable drop + the hidden input — the double-submission guard. */
  busy?: boolean
  onFiles: (files: File[]) => void
  className?: string
}) {
  const [dragging, setDragging] = useState(false)
  const [skipped, setSkipped] = useState<string[]>([])
  const dragDepth = useRef(0)

  const acceptFiles = (files: File[]) => {
    const accepted: File[] = []
    const rejected: string[] = []
    for (const file of files) {
      if (matchesAccept(file, accept)) accepted.push(file)
      else rejected.push(file.name)
    }
    setSkipped(rejected)
    if (accepted.length) onFiles(accepted)
  }

  const endDrag = () => {
    dragDepth.current = 0
    setDragging(false)
  }

  return (
    <label
      aria-busy={busy || undefined}
      onDragEnter={(e) => {
        e.preventDefault()
        if (busy) return
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={(e) => {
        e.preventDefault()
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        endDrag()
        if (busy) return
        const files = Array.from(e.dataTransfer.files)
        if (files.length) acceptFiles(files)
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center transition-colors hover:bg-accent/40",
        dragging && "border-foreground/40 bg-accent/40",
        busy && "pointer-events-none opacity-60",
        className,
      )}
    >
      <input
        type="file"
        className="sr-only"
        accept={accept}
        multiple={multiple}
        disabled={busy}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ""
          if (files.length) acceptFiles(files)
        }}
      />
      <FileUpIcon className="size-5 text-muted-foreground" />
      <span className="text-sm font-medium">{title}</span>
      {hint && (
        <span className="text-xs text-muted-foreground">{hint}</span>
      )}
      {skipped.length > 0 && (
        <span className="text-xs text-muted-foreground" role="status">
          Skipped{" "}
          {skipped.length === 1
            ? skipped[0]
            : `${skipped.length} files`}{" "}
          — accepted types: {accept}
        </span>
      )}
    </label>
  )
}

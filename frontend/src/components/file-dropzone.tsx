import { useState } from "react"
import { FileUpIcon } from "lucide-react"
import { cn } from "cn"

export function FileDropzone({
  accept,
  multiple,
  title,
  hint,
  onFiles,
  className,
}: {
  accept?: string
  multiple?: boolean
  title: string
  hint?: string
  onFiles: (files: File[]) => void
  className?: string
}) {
  const [dragging, setDragging] = useState(false)

  return (
    <label
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length) onFiles(files)
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center transition-colors hover:bg-accent/40",
        dragging && "border-foreground/40 bg-accent/40",
        className,
      )}
    >
      <input
        type="file"
        className="sr-only"
        accept={accept}
        multiple={multiple}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) onFiles(files)
          e.target.value = ""
        }}
      />
      <FileUpIcon className="size-5 text-muted-foreground" />
      <span className="text-sm font-medium">{title}</span>
      {hint && (
        <span className="text-xs text-muted-foreground">{hint}</span>
      )}
    </label>
  )
}

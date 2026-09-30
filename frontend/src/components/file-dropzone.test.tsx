import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { FileDropzone } from "@/components/file-dropzone"

const pdf = new File(["x"], "cv.pdf", { type: "application/pdf" })
const docx = new File(["x"], "cv.docx", {
  type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
})
const txt = new File(["x"], "notes.txt", { type: "text/plain" })

function renderZone(props?: Partial<Parameters<typeof FileDropzone>[0]>) {
  const onFiles = vi.fn()
  const utils = render(
    <FileDropzone
      multiple
      accept=".pdf,.docx"
      title="Drop CVs here"
      onFiles={onFiles}
      {...props}
    />,
  )
  const input = utils.container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement
  const label = utils.container.querySelector("label") as HTMLLabelElement
  return { onFiles, input, label, ...utils }
}

describe("FileDropzone", () => {
  it("passes only accepted files through on change", () => {
    const { onFiles, input } = renderZone()
    fireEvent.change(input, { target: { files: [pdf, txt, docx] } })
    expect(onFiles).toHaveBeenCalledWith([pdf, docx])
    expect(screen.getByText(/Skipped notes\.txt/)).toBeInTheDocument()
  })

  it("filters dropped files by accept and reports the skips", () => {
    const { onFiles, label } = renderZone()
    fireEvent.drop(label, { dataTransfer: { files: [txt, pdf] } })
    expect(onFiles).toHaveBeenCalledWith([pdf])
    expect(
      screen.getByText(/Skipped notes\.txt — accepted types:/),
    ).toBeInTheDocument()
  })

  it("clears the skip notice when a clean batch arrives", () => {
    const { onFiles, input } = renderZone()
    fireEvent.change(input, { target: { files: [txt] } })
    expect(screen.getByText(/Skipped/)).toBeInTheDocument()
    expect(onFiles).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { files: [pdf] } })
    expect(onFiles).toHaveBeenCalledWith([pdf])
    expect(screen.queryByText(/Skipped/)).not.toBeInTheDocument()
  })

  it("disables the hidden input and ignores drops while busy", () => {
    const { onFiles, input, label } = renderZone({ busy: true })
    expect(input).toBeDisabled()
    fireEvent.drop(label, { dataTransfer: { files: [pdf] } })
    expect(onFiles).not.toHaveBeenCalled()
  })

  it("keeps the highlight while the pointer is still inside the zone", () => {
    const { label } = renderZone()
    // Nested dragenter (from a child) must not cancel the highlight —
    // the depth counter only releases on the final dragleave.
    fireEvent.dragEnter(label)
    fireEvent.dragEnter(label)
    fireEvent.dragLeave(label)
    expect(label.className).toContain("border-foreground/40")
    fireEvent.dragLeave(label)
    expect(label.className).not.toContain("border-foreground/40")
  })
})

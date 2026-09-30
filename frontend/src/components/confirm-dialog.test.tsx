import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ConfirmDialog } from "@/components/confirm-dialog"

describe("ConfirmDialog", () => {
  it("renders the title and description, then runs onConfirm", async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete opening?"
        description="This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={onConfirm}
      />,
    )
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText("Delete opening?")).toBeInTheDocument()
    expect(
      within(dialog).getByText("This cannot be undone."),
    ).toBeInTheDocument()

    await user.click(within(dialog).getByRole("button", { name: "Delete" }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it("closes on success and reports the close through onOpenChange", async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn().mockResolvedValue(undefined)
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Archive opening?"
        confirmLabel="Archive"
        onConfirm={onConfirm}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Archive" }))
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("cancels without running onConfirm", async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete opening?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("stays open and shows the error when onConfirm rejects", async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn().mockRejectedValue(new Error("boom"))
    const onOpenChange = vi.fn()
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete opening?"
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Delete" }))
    expect(await screen.findByText("boom")).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})

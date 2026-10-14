import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { Field } from './Field'
import { Input } from './Input'

function DialogHarness({ dismissible = true }: { dismissible?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div data-testid="page">
      <button type="button" onClick={() => setOpen(true)}>
        Cancel visit…
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Cancel this visit?"
        description="The visitor will be notified by email."
        dismissible={dismissible}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Keep visit
            </Button>
            <Button variant="danger">Cancel visit</Button>
          </>
        }
      >
        <Field label="Reason" optional>
          <Input />
        </Field>
      </Dialog>
    </div>
  )
}

async function openDialog() {
  const user = userEvent.setup({ delay: null })
  render(<DialogHarness />)
  const trigger = screen.getByRole('button', { name: 'Cancel visit…' })
  await user.click(trigger)
  return { user, trigger, dialog: screen.getByRole('dialog', { name: 'Cancel this visit?' }) }
}

describe('Dialog', () => {
  it('is a labelled, described modal dialog', async () => {
    const { dialog } = await openDialog()

    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleDescription('The visitor will be notified by email.')
  })

  it('moves focus to the first field of the content, not the close button', async () => {
    await openDialog()
    expect(screen.getByLabelText(/Reason/)).toHaveFocus()
  })

  it('traps focus: Tab and Shift+Tab cycle inside the dialog', async () => {
    const { user } = await openDialog()
    const close = screen.getByRole('button', { name: 'Close' })
    const reason = screen.getByLabelText(/Reason/)
    const keep = screen.getByRole('button', { name: 'Keep visit' })
    const confirm = screen.getByRole('button', { name: 'Cancel visit' })

    await user.tab()
    expect(keep).toHaveFocus()
    await user.tab()
    expect(confirm).toHaveFocus()
    await user.tab() // wraps from the last element to the first
    expect(close).toHaveFocus()
    await user.tab()
    expect(reason).toHaveFocus()
    await user.tab({ shift: true })
    expect(close).toHaveFocus()
    await user.tab({ shift: true }) // wraps from the first element to the last
    expect(confirm).toHaveFocus()
  })

  it('makes the page behind it inert and locks scrolling while open', async () => {
    const { user } = await openDialog()
    const pageRoot = screen.getByTestId('page').parentElement as HTMLElement

    expect(pageRoot).toHaveAttribute('inert')
    expect(document.body.style.overflow).toBe('hidden')

    await user.keyboard('{Escape}')

    expect(pageRoot).not.toHaveAttribute('inert')
    expect(document.body.style.overflow).toBe('')
  })

  it('closes on Escape and returns focus to the element that opened it', async () => {
    const { user, trigger } = await openDialog()

    await user.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('closes from the close button and returns focus', async () => {
    const { user, trigger } = await openDialog()

    await user.click(screen.getByRole('button', { name: 'Close' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('lets footer buttons wrap inside the panel instead of overflowing it', async () => {
    const { dialog } = await openDialog()
    // jsdom has no layout: the classes are the contract (a three-button footer once stuck out of the panel).
    const footer = within(dialog).getByRole('button', { name: 'Keep visit' }).parentElement as HTMLElement
    expect(footer.tagName).toBe('FOOTER')
    expect(footer.className).toContain('sm:flex-row')
    expect(footer.className).toContain('sm:flex-wrap')
    // Reading order: the safe choice first, the primary action last.
    expect(within(footer).getAllByRole('button').map((button) => button.textContent)).toEqual(['Keep visit', 'Cancel visit'])
  })

  it('draws no empty body for content that renders nothing, and then no second hairline over the actions', () => {
    const showError = false
    render(
      <Dialog open onClose={() => {}} role="alertdialog" title="Deactivate Finance?" footer={<Button>Deactivate department</Button>}>
        {showError && <p>Error</p>}
      </Dialog>,
    )
    const dialog = screen.getByRole('alertdialog', { name: 'Deactivate Finance?' })
    // Header and footer only: the header's hairline separates the actions.
    expect(dialog.children).toHaveLength(2)
    expect(within(dialog).getByRole('button', { name: 'Deactivate department' }).parentElement?.className).not.toContain('border-t')
  })

  it('keeps the close button from adding height to the header, so a lone title has equal space above and below', () => {
    render(<Dialog open onClose={() => {}} title="Resend the invitation?" />)
    const close = screen.getByRole('button', { name: 'Close' })
    // 44 px target with negative block margins (10 px each): it lays out 24 px tall, the title's line height.
    expect(close).toHaveClass('size-11', '-my-2.5')
    expect(close.closest('header')).toHaveClass('items-start', 'py-4')
  })

  it('is described by an element of its body when asked (a confirmation’s one consequence, shown as a warning)', () => {
    render(
      <Dialog open onClose={() => {}} role="alertdialog" title="Issue a new pass link?" describedBy="consequence">
        <p id="consequence">The previous QR code will stop working</p>
      </Dialog>,
    )
    expect(screen.getByRole('alertdialog', { name: 'Issue a new pass link?' })).toHaveAccessibleDescription('The previous QR code will stop working')
  })

  it('ignores Escape while not dismissible (e.g. during a pending action)', async () => {
    const user = userEvent.setup({ delay: null })
    render(<DialogHarness dismissible={false} />)
    await user.click(screen.getByRole('button', { name: 'Cancel visit…' }))

    await user.keyboard('{Escape}')

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })
})

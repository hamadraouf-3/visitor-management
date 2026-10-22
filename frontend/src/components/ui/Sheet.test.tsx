import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { Button } from './Button'
import { Sheet } from './Sheet'

function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <div data-testid="page">
      <button type="button" onClick={() => setOpen(true)}>
        Maya Odeh
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Maya Odeh" meta={<span>Cedar Advisory</span>} footer={<Button variant="secondary">Full journey</Button>}>
        <Button>Acknowledge</Button>
      </Sheet>
    </div>
  )
}

describe('Sheet', () => {
  it('is a modal panel named by its title, which takes the focus; Escape closes it and gives the focus back', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    const opener = screen.getByRole('button', { name: 'Maya Odeh' })
    await user.click(opener)

    const sheet = screen.getByRole('dialog', { name: 'Maya Odeh' })
    expect(sheet).toHaveAttribute('aria-modal', 'true')
    // The panel itself, not its first action: nothing is pressed by mistake, the title is read first.
    expect(sheet).toHaveFocus()
    expect(sheet).toHaveTextContent('Cedar Advisory')
    expect(screen.getByTestId('page').closest('[inert]')).not.toBeNull()
    expect(within(sheet).getByRole('button', { name: 'Full journey' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
  })

  it('closes with its Close button', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Maya Odeh' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

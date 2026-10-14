import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Button } from './Button'

function SaveForm({ loading, onSubmit }: { loading: boolean; onSubmit: () => void }) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <input aria-label="Name" />
      <Button type="submit" loading={loading}>
        Save
      </Button>
    </form>
  )
}

describe('Button', () => {
  it('keeps focus on a submit button through a loading cycle and ignores activation meanwhile', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn<() => void>()
    const { rerender } = render(<SaveForm loading={false} onSubmit={onSubmit} />)
    const button = screen.getByRole('button', { name: 'Save' })

    await user.click(button)
    expect(onSubmit).toHaveBeenCalledTimes(1)

    rerender(<SaveForm loading onSubmit={onSubmit} />)
    expect(button).toHaveFocus()
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('aria-busy', 'true')

    await user.click(button)
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(onSubmit).toHaveBeenCalledTimes(1)

    rerender(<SaveForm loading={false} onSubmit={onSubmit} />)
    expect(button).toHaveFocus()
    expect(button).not.toHaveAttribute('aria-disabled')
    expect(button).not.toHaveAttribute('aria-busy')

    await user.keyboard('{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it('does not submit through Enter in a text field while loading (implicit submission)', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn<() => void>()
    const { rerender } = render(<SaveForm loading onSubmit={onSubmit} />)

    await user.type(screen.getByLabelText('Name'), 'Martin{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()

    rerender(<SaveForm loading={false} onSubmit={onSubmit} />)
    await user.type(screen.getByLabelText('Name'), '{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('stays focusable while loading even when it is also disabled', () => {
    render(
      <Button disabled loading>
        Save
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Save' })

    button.focus()

    expect(button).toHaveFocus()
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
  })

  it('uses the native disabled attribute for a plain disabled button', () => {
    render(<Button disabled>Delete</Button>)
    const button = screen.getByRole('button', { name: 'Delete' })

    expect(button).toBeDisabled()
    expect(button).not.toHaveAttribute('aria-disabled')
  })

  it('is focusable but inert when disabled with focusableWhenDisabled', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn<() => void>()
    render(
      <Button disabled focusableWhenDisabled onClick={onClick}>
        Next
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Next' })

    await user.tab()
    expect(button).toHaveFocus()
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')

    await user.click(button)
    await user.keyboard('{Enter}')
    expect(onClick).not.toHaveBeenCalled()
  })

  it('calls onClick when available', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn<() => void>()
    render(<Button onClick={onClick}>Refresh</Button>)

    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Switch } from './Switch'

function Controlled({ onChange, disabled = false, loading = false }: { onChange?: (next: boolean) => void; disabled?: boolean; loading?: boolean }) {
  const [checked, setChecked] = useState(false)
  return (
    <>
      <Switch
        label="Visitor tracking"
        checked={checked}
        disabled={disabled}
        loading={loading}
        aria-describedby={disabled ? 'why' : undefined}
        onCheckedChange={(next) => {
          onChange?.(next)
          setChecked(next)
        }}
      />
      <span id="why">Not allowed</span>
    </>
  )
}

const thumb = () => document.querySelector('[data-switch-thumb]')!
const track = () => document.querySelector('[data-switch-track]')!

describe('Switch', () => {
  it('is a named switch that says its state and changes it on a press, Space or Enter', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn<(next: boolean) => void>()
    render(<Controlled onChange={onChange} />)
    const toggle = screen.getByRole('switch', { name: 'Visitor tracking' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await user.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    toggle.focus()
    await user.keyboard(' ')
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await user.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(onChange.mock.calls).toEqual([[true], [false], [true]])
  })

  it('shows its state by the thumb’s place, and on in the status green, never the company’s colour', () => {
    const { rerender } = render(<Switch label="Tracking" checked={false} onCheckedChange={() => {}} />)
    expect(thumb()).toHaveClass('start-0.5')
    expect(track()).toHaveClass('bg-surface')
    rerender(<Switch label="Tracking" checked onCheckedChange={() => {}} />)
    expect(thumb()).toHaveClass('start-[1.375rem]')
    expect(track()).toHaveClass('bg-success-solid')
    expect(track().className).not.toMatch(/\baccent\b|bg-accent/)
    // Forced colours: the system's colours, the place still says it.
    expect(track()).toHaveClass('forced-colors:bg-[Highlight]')
  })

  it('stays focusable while it cannot change, with its reason as its description, and ignores presses', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn<(next: boolean) => void>()
    render(<Controlled onChange={onChange} disabled />)
    const toggle = screen.getByRole('switch', { name: 'Visitor tracking' })
    expect(toggle).toHaveAttribute('aria-disabled', 'true')
    expect(toggle).not.toBeDisabled()
    expect(toggle).toHaveAccessibleDescription('Not allowed')
    await user.click(toggle)
    await user.tab()
    expect(onChange).not.toHaveBeenCalled()
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  it('is busy while a change is saved', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn<(next: boolean) => void>()
    render(<Controlled onChange={onChange} loading />)
    const toggle = screen.getByRole('switch', { name: 'Visitor tracking' })
    expect(toggle).toHaveAttribute('aria-busy', 'true')
    await user.click(toggle)
    expect(onChange).not.toHaveBeenCalled()
  })
})

import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DateField, type DateFieldProps } from './DateField'

function Harness({
  initial,
  onChange,
  ...props
}: { initial: string | null; onChange?: (value: string | null) => void } & Partial<Omit<DateFieldProps, 'value' | 'onChange'>>) {
  const [value, setValue] = useState(initial)
  return (
    <DateField
      label="From"
      {...props}
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange?.(next)
      }}
    />
  )
}

describe('DateField', () => {
  it('shows a company-local date key as is, with no timezone conversion and no time-zone note', () => {
    render(<Harness initial="2026-10-05" />)

    const input = screen.getByLabelText('From')
    expect(input).toHaveAttribute('type', 'date')
    expect(input).toHaveValue('2026-10-05')
    expect(input).not.toHaveAttribute('aria-describedby')
  })

  it('emits the entered date key, and null when cleared', () => {
    const onChange = vi.fn<(value: string | null) => void>()
    render(<Harness initial={null} onChange={onChange} />)
    const input = screen.getByLabelText('From')

    fireEvent.change(input, { target: { value: '2026-02-28' } })
    expect(onChange).toHaveBeenLastCalledWith('2026-02-28')

    fireEvent.change(input, { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith(null)
    expect(input).toHaveValue('')
  })

  it('passes bounds to the input and wires hint, error and required state through Field', () => {
    render(
      <Harness
        initial="2026-10-05"
        min="2025-10-05"
        max="2026-10-05"
        hint="Up to 366 days."
        error="Choose a start date on or before the end date."
        required
      />,
    )

    const input = screen.getByLabelText(/From/)
    expect(input).toHaveAttribute('min', '2025-10-05')
    expect(input).toHaveAttribute('max', '2026-10-05')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-required', 'true')
    expect(input).toHaveAccessibleDescription('Up to 366 days. Choose a start date on or before the end date.')
  })
})

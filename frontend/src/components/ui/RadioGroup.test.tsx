import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { RadioGroup, type RadioGroupProps, type RadioOption } from './RadioGroup'

type Reason = 'NO_INVITATION' | 'EARLY_ARRIVAL' | 'LOST_PASS' | 'DELIVERY'

const REASONS: RadioOption<Reason>[] = [
  { value: 'NO_INVITATION', label: 'No invitation', description: 'The host did not send an invitation.' },
  { value: 'EARLY_ARRIVAL', label: 'Early arrival' },
  { value: 'LOST_PASS', label: 'Lost pass', disabled: true },
  { value: 'DELIVERY', label: 'Delivery' },
]

function Harness({
  initial = null,
  onValueChange,
  ...props
}: { initial?: Reason | null; onValueChange?: (value: Reason) => void } & Partial<Omit<RadioGroupProps<Reason>, 'value' | 'onValueChange'>>) {
  const [value, setValue] = useState<Reason | null>(initial)
  return (
    <RadioGroup
      label="Reason"
      options={REASONS}
      {...props}
      value={value}
      onValueChange={(next) => {
        setValue(next)
        onValueChange?.(next)
      }}
    />
  )
}

describe('RadioGroup', () => {
  it('is a named radio group with labelled options, hint, error and required state', () => {
    render(<Harness hint="Pick the closest match." error="Choose a reason." required />)

    const group = screen.getByRole('radiogroup', { name: 'Reason' })
    expect(group).toHaveAccessibleDescription('Pick the closest match. Choose a reason.')
    expect(group).toHaveAttribute('aria-invalid', 'true')
    expect(group).toHaveAttribute('aria-required', 'true')
    expect(within(group).getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual([
      'NO_INVITATION',
      'EARLY_ARRIVAL',
      'LOST_PASS',
      'DELIVERY',
    ])
    expect(screen.getByRole('radio', { name: 'No invitation' })).toHaveAccessibleDescription('The host did not send an invitation.')
    expect(screen.getByRole('radio', { name: 'Lost pass' })).toBeDisabled()
    expect(screen.queryAllByRole('radio', { checked: true })).toHaveLength(0)
  })

  it('selects an option on click and reports the value', async () => {
    const user = userEvent.setup({ delay: null })
    const onValueChange = vi.fn<(value: Reason) => void>()
    render(<Harness onValueChange={onValueChange} />)

    await user.click(screen.getByText('Early arrival'))

    expect(onValueChange).toHaveBeenLastCalledWith('EARLY_ARRIVAL')
    expect(screen.getByRole('radio', { name: 'Early arrival' })).toBeChecked()
  })

  it('moves the selection with arrow keys, skipping disabled options', async () => {
    const user = userEvent.setup({ delay: null })
    const onValueChange = vi.fn<(value: Reason) => void>()
    render(<Harness initial="EARLY_ARRIVAL" onValueChange={onValueChange} />)

    await user.tab()
    expect(screen.getByRole('radio', { name: 'Early arrival' })).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('radio', { name: 'Delivery' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Delivery' })).toHaveFocus()

    await user.keyboard('{ArrowUp}')
    expect(screen.getByRole('radio', { name: 'Early arrival' })).toBeChecked()
    expect(onValueChange.mock.calls.map(([value]) => value)).toEqual(['DELIVERY', 'EARLY_ARRIVAL'])
  })

  it('renders touch-sized segments whose selection is marked by more than color', async () => {
    const user = userEvent.setup({ delay: null })
    render(<Harness variant="segmented" size="xl" />)

    await user.click(screen.getByText('Delivery'))

    const selected = screen.getByRole('radio', { name: 'Delivery' })
    expect(selected).toBeChecked()
    const segment = selected.closest('label') as HTMLElement
    expect(segment.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
    expect(segment.className).toContain('min-h-14')
    const other = screen.getByRole('radio', { name: 'Early arrival' }).closest('label') as HTMLElement
    expect(other.querySelector('svg')).toBeNull()
  })

  it('disables every option when the group is disabled', () => {
    render(<Harness disabled />)
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled()
  })
})

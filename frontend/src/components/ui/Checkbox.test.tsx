import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Checkbox } from './Checkbox'

describe('Checkbox', () => {
  it('is a 24 px target on every pointer (WCAG 2.2 SC 2.5.8), not only on touch screens', () => {
    render(<Checkbox label="Beep on check-in and check-out" />)
    const box = screen.getByRole('checkbox', { name: 'Beep on check-in and check-out' })
    expect(box.className).toContain('size-6')
    expect(box.className).not.toMatch(/(^|\s)size-5(\s|$)/)
    expect(box.className).not.toContain('pointer-coarse:size-')
  })

  it('is one tap target with its words: the box, the gap beside it and the label (UX review: a 24 px box with nothing around it)', () => {
    const { container } = render(<Checkbox label="Beep on check-in and check-out" description="Plays a sound." />)
    const box = screen.getByRole('checkbox', { name: 'Beep on check-in and check-out' })
    const row = container.querySelector('label[data-checkbox-row]') as HTMLLabelElement
    // The label holds the box: a tap anywhere in the row, the gap included, ticks it.
    expect(row).toContainElement(box)
    expect(row).toHaveAttribute('for', box.id)
    expect(row).toHaveTextContent('Beep on check-in and check-out')
    // On touch screens the row is 44 px tall (20 px line + 2 × 12 px), without moving what is around it.
    expect(row).toHaveClass('pointer-coarse:py-3', 'pointer-coarse:-my-3')
    // The description is not part of the target, and stands under the words.
    expect(row).not.toHaveTextContent('Plays a sound.')
    expect(screen.getByText('Plays a sound.')).toHaveClass('ps-9')
    row.click()
    expect(box).toBeChecked()
  })

  it('links its description', () => {
    render(<Checkbox label="Notify the host" description="Sends an email when the visitor arrives." />)
    expect(screen.getByRole('checkbox', { name: 'Notify the host' })).toHaveAccessibleDescription('Sends an email when the visitor arrives.')
  })
})

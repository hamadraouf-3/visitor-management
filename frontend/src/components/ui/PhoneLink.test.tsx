import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PhoneLink, PhoneNumber } from './PhoneLink'

describe('PhoneLink', () => {
  it('dials the number shown, in stored order, Arabic-Indic digits too (SEC-33)', () => {
    render(<PhoneLink phone="+٩٦٢ ٧٩ ٥٠٠ ١٠٠٢" label="Call Omar Khalil" />)

    const link = screen.getByRole('link', { name: 'Call Omar Khalil: +٩٦٢ ٧٩ ٥٠٠ ١٠٠٢' })
    expect(link).toHaveAttribute('href', 'tel:+962795001002')
    const number = link.querySelector('bdo')
    expect(number).toHaveAttribute('dir', 'ltr')
    expect(number).toHaveClass('[unicode-bidi:isolate-override]', 'tabular-nums')
    expect(number).toHaveTextContent('+٩٦٢ ٧٩ ٥٠٠ ١٠٠٢')
  })

  it('shows a number that cannot be dialled as shown as plain text, still in stored order', () => {
    // An older row, stored before the server's phone grammar: its digits run together would be
    // another number than either one shown.
    const { container } = render(<PhoneLink phone="079 500 1002 or 1003" label="Call Omar Khalil" className="text-sm" />)

    expect(screen.queryByRole('link')).toBeNull()
    const number = container.querySelector('bdo')
    expect(number).toHaveTextContent('079 500 1002 or 1003')
    expect(number).toHaveAttribute('dir', 'ltr')
    expect(number).toHaveClass('[unicode-bidi:isolate-override]', 'whitespace-nowrap', 'text-sm')
  })
})

describe('PhoneNumber', () => {
  it('keeps marked parts (a search match) inside the left-to-right override', () => {
    const { container } = render(
      <PhoneNumber>
        +٩٦٢ <span data-match="">٧٩</span> ٥٠٠
      </PhoneNumber>,
    )
    const number = container.querySelector('bdo')
    expect(number).toHaveAttribute('dir', 'ltr')
    expect(number?.querySelector('[data-match]')).toHaveTextContent('٧٩')
  })
})

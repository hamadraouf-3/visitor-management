import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Field } from './Field'
import { HighlightMatch } from './HighlightMatch'
import { Input } from './Input'

describe('Field', () => {
  it('describes the control with its hint, then its error', () => {
    render(
      <Field label="Purpose" hint="0 of 500 characters." error="Enter the purpose of the visit.">
        <Input />
      </Field>,
    )
    const input = screen.getByRole('textbox', { name: 'Purpose' })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('0 of 500 characters. Enter the purpose of the visit.')
  })

  it('can leave out a hint that the error repeats, only while there is an error', () => {
    const { rerender } = render(
      <Field label="Email" hint="Needed to email the invitation." hideHintOnError>
        <Input />
      </Field>,
    )
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveAccessibleDescription('Needed to email the invitation.')

    rerender(
      <Field label="Email" hint="Needed to email the invitation." hideHintOnError error="Enter the visitor’s email address to email the invitation.">
        <Input />
      </Field>,
    )
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveAccessibleDescription('Enter the visitor’s email address to email the invitation.')
    expect(screen.queryByText('Needed to email the invitation.')).toBeNull()
  })

  it('marks optional fields in the label, after a real space', () => {
    render(
      <Field label="Phone" optional>
        <Input />
      </Field>,
    )
    expect(screen.getByRole('textbox', { name: 'Phone (optional)' })).not.toHaveAttribute('aria-required')
  })
})

describe('HighlightMatch', () => {
  it('marks the matched part in bold, ignoring case and accents, without an underline that reads as a link', () => {
    const { container } = render(<HighlightMatch text="Élodie Martin" query="elo" />)
    const match = container.querySelector('[data-match]') as HTMLElement
    expect(match).toHaveTextContent('Élo')
    expect(match.className).toContain('font-semibold')
    expect(match.className).not.toContain('underline')
    expect(container).toHaveTextContent('Élodie Martin')
  })
})

import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import { TemporaryPasswordField } from './TemporaryPasswordField'

/*
 * The show/hide button sits over the field's inline end (`end-0`) and the field keeps room for it
 * with its inline-end padding (`pe-12`). Logical sides resolve against the direction of the element
 * that carries them: the input's own (it is `dir="ltr"`, a password reads left to right) and the
 * button's, inherited from its box. In Arabic the box inherited the page's right to left, so the
 * button sat on the left over the password's first characters (L-23). Both must resolve against the
 * same direction. jsdom has no layout: the E2E spec `temporary-password-field.spec.ts` measures it.
 */

/** The direction an element's logical sides resolve against: its own `dir`, else its nearest ancestor's. */
function direction(element: Element): string | null {
  return element.closest('[dir]')?.getAttribute('dir') ?? null
}

function Harness() {
  const [value, setValue] = useState('')
  return <TemporaryPasswordField id="password" value={value} onChange={setValue} email="new.user@example.com" />
}

describe('TemporaryPasswordField', () => {
  afterEach(async () => {
    await act(() => i18n.changeLanguage('en'))
  })

  it.each([
    ['en', 'Temporary password', 'Show password', 'Generate'],
    ['ar', 'كلمة المرور المؤقتة', 'إظهار كلمة المرور', 'إنشاء تلقائي'],
  ] as const)('keeps the show/hide button on the side the field leaves free for it (%s)', async (language, label, toggleName, generate) => {
    await act(() => i18n.changeLanguage(language))
    expect(document.documentElement).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr')
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: generate }))

    const input = screen.getByLabelText(label)
    const toggle = screen.getByRole('button', { name: toggleName })
    expect((input as HTMLInputElement).value).toMatch(/^[\w-]{23}$/)
    expect(input).toHaveClass('pe-12')
    expect(toggle).toHaveClass('end-0')
    // The input's padding and the button's position name the same physical side: the right.
    expect(direction(input)).toBe('ltr')
    expect(direction(toggle)).toBe('ltr')
    // One box holds both, so the button's containing block reads left to right too.
    expect(toggle.parentElement).toBe(input.parentElement)
    expect(toggle.parentElement).toHaveAttribute('dir', 'ltr')
  })
})

import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '../i18n'
import { APPEARANCE_STORAGE_KEY, chooseAppearance, SCHEME_ATTRIBUTE, startAppearance } from './appearance'
import { AppearanceSwitch } from './AppearanceSwitch'

/* The appearance switch of the pages before sign-in and of the pass (Phase 13): a radio group of three. */

afterEach(() => {
  chooseAppearance('system')
  window.localStorage.removeItem(APPEARANCE_STORAGE_KEY)
})

const group = () => screen.getByRole('radiogroup', { name: 'Appearance' })
const radio = (name: string) => within(group()).getByRole('radio', { name })

describe('AppearanceSwitch', () => {
  it('is a radio group named Appearance: Light, Dark and System, each with its symbol, System until the device chooses', () => {
    render(<AppearanceSwitch />)
    expect(within(group()).getAllByRole('radio').map((input) => [input.getAttribute('value'), (input as HTMLInputElement).checked])).toEqual([
      ['light', false],
      ['dark', false],
      ['system', true],
    ])
    for (const name of ['Light', 'Dark', 'System']) expect(radio(name).closest('label')?.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
    // No words besides the three: the group's name is for assistive technology.
    expect(group()).toHaveTextContent(/^AppearanceLightDarkSystem$/)
    expect(group().querySelector('legend')).toHaveClass('sr-only')
  })

  it('draws the page in the chosen scheme at once and keeps the choice on the device', async () => {
    const user = userEvent.setup()
    render(<AppearanceSwitch />)
    await user.click(screen.getByText('Dark'))
    expect(radio('Dark')).toBeChecked()
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe('dark')
    await user.click(screen.getByText('Light'))
    expect(document.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe('light')
    // The chosen segment is the ink tile, whatever the company's colour: a setting, not an action.
    expect(radio('Light').closest('label')).toHaveClass('bg-ink', 'text-on-ink')
    expect(radio('Dark').closest('label')).toHaveClass('bg-surface', 'text-fg')
  })

  it('is one tab stop; the arrow keys move and choose', async () => {
    const user = userEvent.setup()
    render(
      <>
        <button type="button">Before</button>
        <AppearanceSwitch />
        <button type="button">After</button>
      </>,
    )
    screen.getByRole('button', { name: 'Before' }).focus()
    await user.tab()
    expect(radio('System')).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(radio('Dark')).toHaveFocus()
    expect(radio('Dark')).toBeChecked()
    expect(document.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe('dark')
    await user.tab()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
  })

  it('follows a choice made in another tab', () => {
    const stop = startAppearance()
    render(<AppearanceSwitch />)
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, 'light')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: APPEARANCE_STORAGE_KEY, newValue: 'light' }))
    })
    expect(radio('Light')).toBeChecked()
    stop()
  })

  it('speaks Arabic: «المظهر»: «فاتح» «داكن» «تلقائي»', async () => {
    await act(() => i18n.changeLanguage('ar'))
    render(<AppearanceSwitch />)
    expect(screen.getByRole('radiogroup', { name: 'المظهر' })).toBeInTheDocument()
    expect(screen.getAllByRole('radio').map((input) => input.closest('label')?.textContent)).toEqual(['فاتح', 'داكن', 'تلقائي'])
  })
})

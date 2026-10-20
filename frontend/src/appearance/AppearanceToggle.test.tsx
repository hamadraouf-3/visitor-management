import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SWITCH_BUTTON } from '../components/ui/buttonStyles'
import { i18n } from '../i18n'
import { APPEARANCE_STORAGE_KEY, chooseAppearance, DEVICE_DARK_QUERY, SCHEME_ATTRIBUTE, startAppearance, type ColorScheme } from './appearance'
import { AppearanceToggle } from './AppearanceToggle'

/* The appearance toggle (Phase 13, F13-25): one button beside the language switch. */

/** A device whose own colour scheme is `scheme`, and whose changes of it the test makes. */
function device(scheme: ColorScheme) {
  const listeners = new Set<() => void>()
  const list = {
    matches: scheme === 'dark',
    media: DEVICE_DARK_QUERY,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }
  vi.stubGlobal('matchMedia', (query: string) => (query === DEVICE_DARK_QUERY ? list : { matches: false, media: query, addEventListener() {}, removeEventListener() {} }))
  return {
    change(next: ColorScheme) {
      list.matches = next === 'dark'
      act(() => {
        for (const listener of listeners) listener()
      })
    },
  }
}

afterEach(() => {
  chooseAppearance('system')
  window.localStorage.removeItem(APPEARANCE_STORAGE_KEY)
})

const toggle = () => screen.getByRole('button', { name: 'Dark mode' })
const stored = () => window.localStorage.getItem(APPEARANCE_STORAGE_KEY)
const scheme = () => document.documentElement.getAttribute(SCHEME_ATTRIBUTE)
/** The symbol shown: lucide names its icons in a class (`lucide-moon`, `lucide-sun`). */
const symbol = () => toggle().querySelector('svg')?.getAttribute('class')?.match(/lucide-(moon|sun)\b/)?.[1]

describe('AppearanceToggle', () => {
  it('is one toggle button named Dark mode, its name its tooltip, no words on screen, the language switch’s own look', () => {
    device('light')
    render(<AppearanceToggle />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    expect(toggle()).toHaveAttribute('title', 'Dark mode')
    expect(toggle()).toHaveAttribute('type', 'button')
    // The only text is the name for assistive technology; the symbol is hidden from it.
    expect(toggle().querySelector('.sr-only')).toHaveTextContent('Dark mode')
    expect(toggle().querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(toggle()).toHaveClass(...SWITCH_BUTTON.split(' '))
    // The moon while light: the scheme a press leads to.
    expect(symbol()).toBe('moon')
  })

  it('follows the device until it is pressed, live, and keeps nothing', () => {
    const screenOf = device('dark')
    const stop = startAppearance()
    render(<AppearanceToggle />)
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(symbol()).toBe('sun')
    screenOf.change('light')
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    expect(symbol()).toBe('moon')
    expect(scheme()).toBe('light')
    expect(stored()).toBeNull()
    stop()
  })

  it('draws the other scheme than the one shown and keeps that choice on the device, at each press', async () => {
    const user = userEvent.setup()
    const screenOf = device('dark')
    const stop = startAppearance()
    render(<AppearanceToggle />)
    // A device in its dark scheme: dark is shown, so a press keeps Light.
    await user.click(toggle())
    expect(stored()).toBe('light')
    expect(scheme()).toBe('light')
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    // The choice holds whatever the device says from now on.
    screenOf.change('light')
    screenOf.change('dark')
    expect(scheme()).toBe('light')
    await user.click(toggle())
    expect(stored()).toBe('dark')
    expect(scheme()).toBe('dark')
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    // The focus stays on the button.
    expect(toggle()).toHaveFocus()
    stop()
  })

  it('takes Enter and Space as a press (a native button)', async () => {
    const user = userEvent.setup()
    device('light')
    render(<AppearanceToggle />)
    toggle().focus()
    await user.keyboard('{Enter}')
    expect(stored()).toBe('dark')
    await user.keyboard(' ')
    expect(stored()).toBe('light')
  })

  it('reads a System an earlier build kept as no choice: the device’s scheme, and a press keeps its opposite', async () => {
    const user = userEvent.setup()
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, 'system')
    device('dark')
    render(<AppearanceToggle />)
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    await user.click(toggle())
    expect(stored()).toBe('light')
  })

  it('follows a press made in another tab, and storage cleared there', () => {
    device('light')
    const stop = startAppearance()
    render(<AppearanceToggle />)
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, 'dark')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: APPEARANCE_STORAGE_KEY, newValue: 'dark' }))
    })
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    window.localStorage.clear()
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null }))
    })
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')
    stop()
  })

  it('on a screen dark by design (the reception) says dark until a choice, and a press asks for light', async () => {
    const user = userEvent.setup()
    device('light')
    render(<AppearanceToggle darkSurface />)
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(symbol()).toBe('sun')
    await user.click(toggle())
    expect(stored()).toBe('light')
  })

  it('speaks Arabic: «الوضع الداكن»', async () => {
    await act(() => i18n.changeLanguage('ar'))
    device('light')
    render(<AppearanceToggle />)
    const button = screen.getByRole('button', { name: 'الوضع الداكن' })
    expect(button).toHaveAttribute('title', 'الوضع الداكن')
    expect(button).toHaveAttribute('aria-pressed', 'false')
  })
})

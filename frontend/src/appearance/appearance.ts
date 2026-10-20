import { withoutTransitions } from '../identity/document'

/*
 * The appearance this device chose (Phase 13): Light, Dark, or System (the default), and the colour
 * scheme a page is drawn in: the choice, or under System the device's own (`prefers-color-scheme`).
 *
 * - The person chooses with one toggle (`AppearanceToggle`, F13-25): until they press it the page
 *   follows the device (System); a press keeps the other scheme than the one shown, Light or Dark.
 *   Nothing in the interface leads back to System; a `system` kept by an earlier build still means it.
 * - One choice per device, for every company and for the platform owner's area alike: not an
 *   account's preference. It is kept in `localStorage` (`vms.appearance`); every read and write may
 *   fail (private browsing, blocked storage), and storage that cannot be read is no choice: System.
 * - `public/appearance.js` puts the scheme on the document before the first paint, from the same key
 *   by the same rule (`appearance.test.ts` runs that file against this module). From then on
 *   `startAppearance` keeps it there: after a choice on this page, a choice made in another tab (the
 *   `storage` event) and, under System, a change of the device's own scheme.
 * - On the document the scheme is `data-scheme` on the root element, the stylesheet's one switch for
 *   every rule that means dark (`index.css`: the `scheme-dark` variant), and the `color-scheme` meta
 *   (the browser's own canvas and controls). What chooses something by the scheme in script (a logo's
 *   file, the browser chrome's colour, a preview) reads `useColorScheme()`.
 */

export const APPEARANCES = ['light', 'dark', 'system'] as const

export type Appearance = (typeof APPEARANCES)[number]

/** The colour scheme a page is drawn in. */
export type ColorScheme = 'light' | 'dark'

export const DEFAULT_APPEARANCE: Appearance = 'system'

/** Key of the device's choice in `localStorage` (also read by `public/appearance.js`). */
export const APPEARANCE_STORAGE_KEY = 'vms.appearance'

/** The root element's attribute that carries the scheme (also set by `public/appearance.js`). */
export const SCHEME_ATTRIBUTE = 'data-scheme'

/** The device's own colour scheme: dark when this matches. */
export const DEVICE_DARK_QUERY = '(prefers-color-scheme: dark)'

export function isAppearance(value: unknown): value is Appearance {
  return typeof value === 'string' && (APPEARANCES as readonly string[]).includes(value)
}

/** A choice storage refused to keep: it still holds for this page. */
let unsaved: Appearance | null = null

/** The device's choice: System when none is stored, or storage cannot be read. */
export function readAppearance(): Appearance {
  if (unsaved) return unsaved
  try {
    const stored = window.localStorage.getItem(APPEARANCE_STORAGE_KEY)
    return isAppearance(stored) ? stored : DEFAULT_APPEARANCE
  } catch {
    return DEFAULT_APPEARANCE
  }
}

function deviceQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(DEVICE_DARK_QUERY) : null
}

/** The device's own colour scheme (light where the browser cannot say). */
export function deviceScheme(): ColorScheme {
  return deviceQuery()?.matches ? 'dark' : 'light'
}

/** The scheme a page is drawn in for a choice: the choice itself, or under System the device's. */
export function schemeOf(appearance: Appearance, device: ColorScheme): ColorScheme {
  return appearance === 'system' ? device : appearance
}

/** The scheme this page is drawn in now. */
export function currentScheme(): ColorScheme {
  return schemeOf(readAppearance(), deviceScheme())
}

/**
 * Puts a scheme on the document. A change replaces the colours at once: nothing fades from the old
 * scheme to the new one (the transitions of buttons and links are off for two frames).
 */
export function applyScheme(document: Document, scheme: ColorScheme): void {
  const root = document.documentElement
  if (root.getAttribute(SCHEME_ATTRIBUTE) !== scheme) {
    root.setAttribute(SCHEME_ATTRIBUTE, scheme)
    withoutTransitions(document)
  }
  const meta = document.head.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
  if (meta && meta.content !== scheme) meta.content = scheme
}

const listeners = new Set<() => void>()

function changed(): void {
  applyScheme(document, currentScheme())
  for (const listener of listeners) listener()
}

/** Calls `listener` whenever the choice or the scheme changes; answers the function that stops it. */
export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The device's new choice: kept in storage, and on the page at once. */
export function chooseAppearance(appearance: Appearance): void {
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance)
    unsaved = null
  } catch {
    // Storage unavailable (private mode, quota): the choice holds for this page only.
    unsaved = appearance
  }
  changed()
}

/**
 * Keeps the document in the device's scheme from now on (`main.tsx`, before the first render): it
 * puts the scheme on the document (the same one `public/appearance.js` did, unless that file was not
 * there) and follows a choice made in another tab and, under System, the device's own scheme as it
 * changes. Answers the function that stops it (tests).
 */
export function startAppearance(): () => void {
  applyScheme(document, currentScheme())
  const onStorage = (event: StorageEvent) => {
    // `key` null: another tab cleared the storage.
    if (event.key === APPEARANCE_STORAGE_KEY || event.key === null) changed()
  }
  const device = deviceQuery()
  window.addEventListener('storage', onStorage)
  device?.addEventListener('change', changed)
  return () => {
    window.removeEventListener('storage', onStorage)
    device?.removeEventListener('change', changed)
  }
}

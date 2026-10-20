/*
 * Type tests of the menu's items (Phase 14, F14-20), checked by `tsc -b`: this file is in the app's
 * project and imported by nothing, so it is never built into the app. A menu opens an `href` item in a
 * new tab, so it takes an `https:` address only: never a script's, a data address or plain HTTP. Each
 * `@ts-expect-error` line must stay an error; one that no longer is fails the type check.
 */
import type { MenuItem } from './Menu'

declare const text: string

export const MENU_HREF_TYPE_CHECKS: readonly MenuItem[] = [
  { id: 'calendar', label: 'Google Calendar', href: 'https://calendar.google.com/calendar/render' },
  { id: 'built', label: 'Built', href: `https://calendar.google.com/calendar/render?text=${text}` },
  // @ts-expect-error a script's address
  { id: 'script', label: 'Script', href: 'javascript:alert(1)' },
  // @ts-expect-error a data address
  { id: 'data', label: 'Data', href: 'data:text/html,<p>page</p>' },
  // @ts-expect-error plain HTTP
  { id: 'http', label: 'Plain', href: 'http://calendar.google.com/calendar/render' },
  // @ts-expect-error any string at all
  { id: 'any', label: 'Any', href: text },
  // @ts-expect-error a string built by concatenation is any string
  { id: 'concatenated', label: 'Concatenated', href: 'https://' + text },
]

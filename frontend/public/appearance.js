/*
 * The colour scheme a page is drawn in, before anything is drawn (Phase 13).
 *
 * Each device chooses its appearance: Light, Dark or System (the default: the device's own colour
 * scheme), kept in `localStorage` under `vms.appearance` (src/appearance/appearance.ts, which takes
 * over once the app runs, by the same rule: appearance.test.ts runs this file against it). This
 * classic script runs in <head>, before the stylesheet, and puts that scheme on the root element
 * (`data-scheme`: the stylesheet's one switch for every dark rule) and in the `color-scheme` meta
 * (the browser's own canvas until the stylesheet applies), so a dark page is dark from its first
 * frame. A file of its own, since the page's policy allows no inline script (`script-src 'self'`).
 * Storage that cannot be read is no choice: the device's scheme. In the dark scheme the browser
 * chrome's colour (`theme-color`, index.html's light one until here) is a neutral page's dark one
 * (DEFAULT_THEME_COLORS in src/identity/tokens.ts); the app puts the colour of the page's own
 * identity in its place before its first render.
 */
;(() => {
  'use strict'
  let choice = null
  try {
    choice = window.localStorage.getItem('vms.appearance')
  } catch {
    choice = null
  }
  const deviceDark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
  const scheme = choice === 'dark' || (choice !== 'light' && deviceDark) ? 'dark' : 'light'
  document.documentElement.setAttribute('data-scheme', scheme)
  const meta = document.querySelector('meta[name="color-scheme"]')
  if (meta) meta.setAttribute('content', scheme)
  const chrome = document.querySelector('meta[name="theme-color"]')
  if (chrome && scheme === 'dark') chrome.setAttribute('content', '#0f3b3f')
})()

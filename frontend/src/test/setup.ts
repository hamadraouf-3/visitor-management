import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { APPEARANCE_STORAGE_KEY, SCHEME_ATTRIBUTE } from '../appearance/appearance'
import { i18n, LANGUAGE_STORAGE_KEY } from '../i18n'
import { BRANDS_STORAGE_KEY, COMPANY_STORAGE_KEY } from '../identity/storage'
import { LANGUAGE_CHOSEN_KEY } from '../i18n/languages'
import { assertNoUnhandledRequests } from './api'
import { disposeRouters } from './render'

type DecoderModule = typeof import('../scanner/zxing')

// The decoder module is the only code that downloads and compiles the zxing wasm, which jsdom
// cannot do (any route that mounts /reception preloads it). Every test therefore gets an inert
// decoder: no native detector, the preload succeeds, detections find nothing. Tests of the
// decoder itself opt out with `vi.unmock('./zxing')`.
vi.mock(import('../scanner/zxing'), () => ({
  ZXING_WASM_URL: '/assets/zxing_reader.wasm',
  ZXING_MODULE_OVERRIDES: { locateFile: (path: string, prefix: string) => prefix + path },
  supportsNativeQrDetection: vi.fn<DecoderModule['supportsNativeQrDetection']>(() => Promise.resolve(false)),
  configureZXing: vi.fn<DecoderModule['configureZXing']>(),
  preloadQrDecoder: vi.fn<DecoderModule['preloadQrDecoder']>(() => Promise.resolve('zxing')),
  createQrDetector: vi.fn<DecoderModule['createQrDetector']>(() =>
    Promise.resolve({ engine: 'zxing', detector: { detect: () => Promise.resolve([]) } }),
  ),
}))

// Tests read the English UI (F10-12): every test starts in English, whatever an earlier one switched to.
void i18n.changeLanguage('en')

// Most tests render the whole app (session check, a lazy route, then the page's requests) and
// run beside many other files: a `findBy` waits up to 5 s before a missing element counts as a
// failure, so a loaded machine does not fail a correct test (with `testTimeout` in the config).
configure({ asyncUtilTimeout: 5_000 })

// A few files run in the Node environment (`// @vitest-environment node`) and have no DOM.
const hasDom = typeof window !== 'undefined'

if (hasDom) {
  // jsdom does not implement scrolling; React Router's ScrollRestoration calls it.
  window.scrollTo = () => {}

  // In a browser `document.hasFocus()` says whether the page's window has the system focus,
  // also while nothing in it is focused; jsdom answers false until an element was focused.
  // Tests run as in a focused browser window (a test of the other case stubs it).
  document.hasFocus = () => true

  // Browsers apply the HTML "focus fixup rule": a focused element that becomes disabled (itself
  // or through a disabled fieldset) loses focus to the document. jsdom keeps it focused, which
  // would let tests pass for controls that strand keyboard users. Emulated here so focus
  // assertions mean what they say in a browser. jsdom's blur() ignores an element that is no
  // longer focusable, so the body is made focusable for a moment and focused instead (the
  // document's focused area is reported as the body either way).
  new MutationObserver(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.matches(':disabled')) return
    document.body.tabIndex = -1
    document.body.focus()
    document.body.removeAttribute('tabindex')
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['disabled'] })
}

function clearCookies() {
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0]?.trim()
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`
  }
}

afterEach(() => {
  if (hasDom) {
    cleanup()
    disposeRouters()
    clearCookies()
    document.body.innerHTML = ''
    document.body.removeAttribute('style')
    // The identity a page put on the document (Phase 12): its colours, its icon, its manifest.
    document.documentElement.removeAttribute('style')
    // The colour scheme of the device's appearance (Phase 13): the next test starts with none chosen.
    document.documentElement.removeAttribute(SCHEME_ATTRIBUTE)
    delete document.documentElement.dataset.identityIcons
    for (const link of document.head.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')) link.remove()
    window.history.replaceState(null, '', '/')
    try {
      window.localStorage.removeItem(LANGUAGE_STORAGE_KEY)
      // What a signed-in page left of its company (Phase 12): the next test starts on a device that knows none.
      window.localStorage.removeItem(COMPANY_STORAGE_KEY)
      window.localStorage.removeItem(BRANDS_STORAGE_KEY)
      window.localStorage.removeItem(APPEARANCE_STORAGE_KEY)
      window.sessionStorage.removeItem(LANGUAGE_CHOSEN_KEY)
    } catch {
      // A test made storage throw (private mode); nothing was stored then.
    }
  }
  if (i18n.language !== 'en') void i18n.changeLanguage('en')
  // Last, so requests made while unmounting count too. Fails the test that made them.
  assertNoUnhandledRequests()
})

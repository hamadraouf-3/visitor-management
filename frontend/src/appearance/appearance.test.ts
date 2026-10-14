import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { documentIdentityOf, IDENTITY_CHANGE_ATTRIBUTE } from '../identity/document'
import { NEUTRAL } from '../identity/identity'
import {
  APPEARANCE_STORAGE_KEY,
  APPEARANCES,
  applyScheme,
  chooseAppearance,
  currentScheme,
  DEVICE_DARK_QUERY,
  readAppearance,
  schemeOf,
  SCHEME_ATTRIBUTE,
  startAppearance,
  subscribeAppearance,
  type Appearance,
  type ColorScheme,
} from './appearance'

/*
 * The device's appearance (Phase 13): the choice, the scheme it draws the page in, the document, and
 * the script that does the same before the first paint (`public/appearance.js`).
 */

/** The frontend's own folder (the page shell, public/, src/). */
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (file: string) => readFileSync(path.join(frontend, file), 'utf8')

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
    listeners,
    change(next: ColorScheme) {
      list.matches = next === 'dark'
      for (const listener of listeners) listener()
    },
  }
}

/** Storage that refuses every read and write (private browsing, blocked site data). */
function blockStorage() {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('Blocked', 'SecurityError')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Blocked', 'SecurityError')
  })
}

const root = () => document.documentElement
const colourSchemeMeta = () => document.head.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
const themeColourMeta = () => document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
/** Two frames on: what was scheduled for after the next paint has run. */
const twoFrames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

beforeEach(() => {
  document.head.innerHTML = '<meta name="color-scheme" content="light dark" />'
})

afterEach(() => {
  vi.restoreAllMocks()
  // A choice that storage refused is kept for the page: a working storage takes it back.
  chooseAppearance('system')
  window.localStorage.removeItem(APPEARANCE_STORAGE_KEY)
  document.head.innerHTML = ''
})

describe('the device’s choice', () => {
  it('is System until the device chooses, and whatever else storage holds', () => {
    expect(readAppearance()).toBe('system')
    for (const stored of ['', 'auto', 'DARK', 'null', '{"dark":true}']) {
      window.localStorage.setItem(APPEARANCE_STORAGE_KEY, stored)
      expect(readAppearance(), `stored: ${stored}`).toBe('system')
    }
    for (const appearance of APPEARANCES) {
      window.localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance)
      expect(readAppearance()).toBe(appearance)
    }
  })

  it('is kept under one key, for every company and the platform owner’s area alike', () => {
    chooseAppearance('dark')
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe('dark')
    expect(APPEARANCE_STORAGE_KEY).toBe('vms.appearance')
  })

  it('is System when storage cannot be read, and a choice still holds for the page when storage refuses it', () => {
    blockStorage()
    expect(readAppearance()).toBe('system')
    chooseAppearance('dark')
    expect(readAppearance()).toBe('dark')
    expect(root().getAttribute(SCHEME_ATTRIBUTE)).toBe('dark')
  })
})

describe('the scheme a page is drawn in', () => {
  it('is the choice, or under System the device’s own', () => {
    const table: [Appearance, ColorScheme, ColorScheme][] = [
      ['light', 'light', 'light'],
      ['light', 'dark', 'light'],
      ['dark', 'light', 'dark'],
      ['dark', 'dark', 'dark'],
      ['system', 'light', 'light'],
      ['system', 'dark', 'dark'],
    ]
    for (const [appearance, deviceScheme, expected] of table) expect(schemeOf(appearance, deviceScheme), `${appearance} on a ${deviceScheme} device`).toBe(expected)
  })

  it('is light where the browser cannot say what the device’s scheme is', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(currentScheme()).toBe('light')
    chooseAppearance('dark')
    expect(currentScheme()).toBe('dark')
  })

  it('is on the root element and in the colour-scheme meta, and a change of it replaces the colours at once', async () => {
    applyScheme(document, 'dark')
    expect(root().getAttribute(SCHEME_ATTRIBUTE)).toBe('dark')
    expect(colourSchemeMeta()?.content).toBe('dark')
    expect(root().hasAttribute(IDENTITY_CHANGE_ATTRIBUTE)).toBe(true)
    await twoFrames()
    expect(root().hasAttribute(IDENTITY_CHANGE_ATTRIBUTE)).toBe(false)
    // The same scheme again changes nothing.
    applyScheme(document, 'dark')
    expect(root().hasAttribute(IDENTITY_CHANGE_ATTRIBUTE)).toBe(false)
    applyScheme(document, 'light')
    expect(root().getAttribute(SCHEME_ATTRIBUTE)).toBe('light')
    expect(colourSchemeMeta()?.content).toBe('light')
  })
})

describe('the document, kept in the scheme once the app runs', () => {
  it('follows a choice on this page, and tells whoever listens', () => {
    device('light')
    const stop = startAppearance()
    const heard = vi.fn<() => void>()
    const unsubscribe = subscribeAppearance(heard)
    expect(root().getAttribute(SCHEME_ATTRIBUTE)).toBe('light')
    chooseAppearance('dark')
    expect(root().getAttribute(SCHEME_ATTRIBUTE)).toBe('dark')
    expect(heard).toHaveBeenCalledTimes(1)
    unsubscribe()
    stop()
  })

  it('follows the device’s own scheme live under System, and not under a choice', () => {
    const screen = device('light')
    const stop = startAppearance()
    expect(root().getAttribute(SCHEME_ATTRIBUTE)).toBe('light')
    screen.change('dark')
    expect(root().getAttribute(SCHEME_ATTRIBUTE)).toBe('dark')
    chooseAppearance('light')
    screen.change('dark')
    expect(root().getAttribute(SCHEME_ATTRIBUTE)).toBe('light')
    chooseAppearance('system')
    expect(root().getAttribute(SCHEME_ATTRIBUTE)).toBe('dark')
    stop()
    expect(screen.listeners.size).toBe(0)
  })

  it('follows a choice made in another tab (the storage event), and a storage cleared there', () => {
    device('light')
    const stop = startAppearance()
    // Another tab writes the key; this one hears of it through the storage event.
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, 'dark')
    window.dispatchEvent(new StorageEvent('storage', { key: APPEARANCE_STORAGE_KEY, newValue: 'dark' }))
    expect(root().getAttribute(SCHEME_ATTRIBUTE)).toBe('dark')
    // Another key changes nothing here.
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, 'light')
    window.dispatchEvent(new StorageEvent('storage', { key: 'vms.language', newValue: 'ar' }))
    expect(root().getAttribute(SCHEME_ATTRIBUTE)).toBe('dark')
    window.localStorage.clear()
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
    expect(root().getAttribute(SCHEME_ATTRIBUTE)).toBe('light')
    stop()
  })
})

describe('before the first paint: public/appearance.js', () => {
  const script = read('public/appearance.js')
  /** Runs the file as the browser does, in this document. */
  // oxlint-disable-next-line no-new-func
  const run = () => new Function(script)()

  /** The browser chrome's colour the app gives a neutral page (`identity/document.ts`): the head's own one in the light scheme. */
  const neutralChrome = documentIdentityOf(NEUTRAL, '/login').themeColors

  it('draws the page in the same scheme as the app, for every choice, every device and a storage that cannot be read', () => {
    // The head as index.html ships it: the light chrome colour, which the dark scheme replaces.
    document.head.insertAdjacentHTML('beforeend', `<meta name="theme-color" content="${neutralChrome.light}" />`)
    const stored: (string | null)[] = [null, ...APPEARANCES, 'junk']
    for (const deviceScheme of ['light', 'dark'] as const) {
      device(deviceScheme)
      for (const value of stored) {
        if (value === null) window.localStorage.removeItem(APPEARANCE_STORAGE_KEY)
        else window.localStorage.setItem(APPEARANCE_STORAGE_KEY, value)
        root().removeAttribute(SCHEME_ATTRIBUTE)
        colourSchemeMeta()!.content = 'light dark'
        themeColourMeta()!.content = neutralChrome.light
        run()
        expect(root().getAttribute(SCHEME_ATTRIBUTE), `${String(value)} on a ${deviceScheme} device`).toBe(currentScheme())
        expect(colourSchemeMeta()?.content, `${String(value)} on a ${deviceScheme} device`).toBe(currentScheme())
        // The chrome's colour of the first frame is the one the app gives the page in that scheme: no light chrome above a dark page.
        expect(themeColourMeta()?.content, `${String(value)} on a ${deviceScheme} device`).toBe(neutralChrome[currentScheme()])
      }
      blockStorage()
      themeColourMeta()!.content = neutralChrome.light
      run()
      expect(root().getAttribute(SCHEME_ATTRIBUTE), `blocked storage on a ${deviceScheme} device`).toBe(deviceScheme)
      expect(themeColourMeta()?.content, `blocked storage on a ${deviceScheme} device`).toBe(neutralChrome[deviceScheme])
      vi.restoreAllMocks()
    }
  })

  it('reads the app’s own key and sets the app’s own attribute', () => {
    expect(script).toContain(`'${APPEARANCE_STORAGE_KEY}'`)
    expect(script).toContain(`'${SCHEME_ATTRIBUTE}'`)
    expect(script).toContain(`'${DEVICE_DARK_QUERY}'`)
  })

  it('runs in the head before anything is drawn: a classic script of its own, before the stylesheet and the app', () => {
    const html = read('index.html')
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'))
    const tag = head.match(/<script\b[^>]*src="\/appearance\.js"[^>]*><\/script>/)?.[0]
    expect(tag).toBe('<script src="/appearance.js"></script>')
    // Before the colour-scheme meta's reader can miss it: the meta comes first, the app after.
    expect(head.indexOf('name="color-scheme"')).toBeLessThan(head.indexOf(tag!))
    expect(head).not.toMatch(/<link[^>]*rel="stylesheet"/)
    expect(html.indexOf(tag!)).toBeLessThan(html.indexOf('type="module"'))
    // No inline script anywhere: the policy is `script-src 'self'`.
    expect([...html.matchAll(/<script\b([^>]*)>/g)].every(([, attributes]) => /\bsrc=/.test(attributes!))).toBe(true)
    // The browser chrome's colour is one meta, set for the scheme the page is drawn in (identity/document.ts).
    expect(head.match(/name="theme-color"/g)).toHaveLength(1)
    expect(head).toContain(`<meta name="theme-color" content="${documentIdentityOf(NEUTRAL, '/login').themeColors.light}" />`)
    expect(head).not.toMatch(/prefers-color-scheme/)
  })
})

/** Every source file of the app (tests aside): what could ask for the device's scheme itself. */
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name)
    if (statSync(file).isDirectory()) return sources(file)
    return /\.(ts|tsx|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [file] : []
  })
}

describe('one switch for every rule that means dark', () => {
  const files = sources(path.join(frontend, 'src'))
  const relative = (file: string) => path.relative(frontend, file).split(path.sep).join('/')

  it('the stylesheet asks for the root’s scheme, never for the device’s', () => {
    const css = read('src/index.css').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).not.toMatch(/prefers-color-scheme/)
    expect(css).toMatch(/@custom-variant scheme-dark \{\s*@media screen \{\s*&:where\(:root\[data-scheme='dark'\], :root\[data-scheme='dark'\] \*\)/)
  })

  it('no source but the appearance’s own asks the device for its scheme', () => {
    expect(files.length).toBeGreaterThan(100)
    const asking = files.filter((file) => /prefers-color-scheme/.test(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
    expect(asking.map(relative)).toEqual(['src/appearance/appearance.ts'])
  })

  it('no class uses Tailwind’s own dark variant, which follows the device and not the choice', () => {
    const using = files.filter((file) => /[\s'"`]dark:[a-z-]/.test(readFileSync(file, 'utf8')))
    expect(using.map(relative)).toEqual([])
  })
})

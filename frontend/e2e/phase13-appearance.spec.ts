import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Browser, type BrowserContextOptions, type Locator, type Page } from '@playwright/test'
import type { EmailTemplate, ReceptionToday } from '../src/types/api.ts'
import { mockPalette } from './support/mock-brand.ts'
import { drawFile, MOCK_VISITS, mockCompanyApi, platformCompanyOf, type MockApiOptions, type MockCompany, type MockFiles } from './support/mock-company.ts'

/*
 * The device's appearance in the browser (Phase 13, decisions F13-1 on, the toggle F13-25 and the logo
 * without a plate F13-26), what jsdom cannot show. The API is mocked, so this spec needs only the Vite
 * server.
 *
 * - One toggle beside the language switch, on the signed-out pages, the pass and both shells: its
 *   name, its state, its keys, its place and size, both languages, every width; none in the account
 *   menus.
 * - Until it is pressed the page follows the device's own scheme, live; a press keeps the other
 *   scheme than the one shown, on the device: across reloads, on every company's pages and the
 *   platform's, and in another tab at once. A `system` an earlier build kept still follows the device.
 * - A page with Dark stored is dark from its first frame: the scheme is on the root element before
 *   anything is drawn, and no frame of a reload is white.
 * - The logos and the browser chrome's colour follow the choice, not the device; paper stays light.
 *   In the light scheme a company's logo stands on the page itself, a plate only where a logo for light
 *   surfaces stands on a dark page; nothing but the logo changes when the scheme does.
 * - The reception screen is dark under no choice as before and follows an explicit one; the toggle
 *   says dark there; its camera panel is the dark panel in both.
 */

const FIRST_RENDER = { timeout: 30_000 }
const APPEARANCE_KEY = 'vms.appearance'
const PASS_TOKEN = 'rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2AXo3_vK9-aQ2'
const DARK_MODE = { en: 'Dark mode', ar: 'الوضع الداكن' } as const

/** A yellow company: a light shell under dark ink, the deep shell and its logo for dark surfaces in the dark scheme. */
const SAHARA: MockCompany = { slug: 'sahara', name: 'Sahara Sun Hotels', name_ar: 'فنادق شمس الصحراء', colour: '#f5b800' }
/** A navy bank, as the owner saw it in production: a transparent wordmark for light surfaces, a mark alone for dark ones. */
const BANK: MockCompany = { slug: 'jordan-kuwait-bank', name: 'Jordan Kuwait Bank', name_ar: 'البنك الأردني الكويتي', colour: '#003876' }

/** The canvas of each scheme (`index.css`): #f1f1f1 and #101619. */
const CANVAS = { light: 'rgb(241, 241, 241)', dark: 'rgb(16, 22, 25)' } as const

async function openWith(browser: Browser, projectUse: BrowserContextOptions, options: BrowserContextOptions = {}): Promise<Page> {
  const context = await browser.newContext({ baseURL: projectUse.baseURL, locale: 'en-US', viewport: projectUse.viewport, hasTouch: projectUse.hasTouch, ...options })
  return context.newPage()
}

/** A browser context whose device already chose `appearance` (as a person did on an earlier visit). */
const stored = (projectUse: BrowserContextOptions, appearance: string): BrowserContextOptions => ({
  storageState: { cookies: [], origins: [{ origin: String(projectUse.baseURL), localStorage: [{ name: APPEARANCE_KEY, value: appearance }] }] },
})

/** A wordmark in `colour` on a transparent ground (`drawFile`'s drawing code). */
const wordmark = (colour: string) => `x.clearRect(0,0,w,h); x.fillStyle='${colour}'; x.font='bold 120px Arial'; x.textBaseline='middle'; x.fillText('SAHARA',20,h/2);`

/** The company's two logos, drawn: a dark wordmark for light surfaces, the same in white for dark ones. */
async function logos(page: Page): Promise<MockFiles> {
  await page.goto('about:blank')
  const light = await drawFile(page, 'logo.png', 600, 200, wordmark('#3b2a12'))
  const dark = await drawFile(page, 'logo-dark.png', 600, 200, wordmark('#ffffff'))
  return { logo: light.buffer, logo_dark: dark.buffer }
}

/**
 * The bank's logos, drawn as production has them: a navy diamond and wordmark on a transparent ground
 * (609 × 159) with a few opaque white pixels inside the diamond, and for dark surfaces the mark alone
 * (423 × 570), an emblem the company's name is written beside.
 */
async function bankLogos(page: Page, { dark = true }: { dark?: boolean } = {}): Promise<MockFiles> {
  await page.goto('about:blank')
  const light = await drawFile(
    page,
    'logo.png',
    609,
    159,
    "x.clearRect(0,0,w,h); x.fillStyle='#003876'; x.beginPath(); x.moveTo(80,8); x.lineTo(150,80); x.lineTo(80,152); x.lineTo(10,80); x.closePath(); x.fill(); " +
      "x.fillStyle='#ffffff'; x.fillRect(56,56,48,48); x.fillStyle='#e30613'; x.fillRect(72,72,16,16); " +
      "x.fillStyle='#003876'; x.font='bold 54px Arial'; x.textBaseline='middle'; x.fillText('Jordan Kuwait',170,58); x.font='bold 40px Arial'; x.fillText('Bank',170,116);",
  )
  if (!dark) return { logo: light.buffer }
  const mark = await drawFile(
    page,
    'logo-dark.png',
    423,
    570,
    "x.clearRect(0,0,w,h); x.fillStyle='#ffffff'; x.beginPath(); x.moveTo(211,20); x.lineTo(403,285); x.lineTo(211,550); x.lineTo(20,285); x.closePath(); x.fill(); x.fillStyle='#e30613'; x.fillRect(176,250,70,70);",
  )
  return { logo: light.buffer, logo_dark: mark.buffer }
}

const schemeOf = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-scheme'))
const canvasOf = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
const storedChoice = (page: Page) => page.evaluate((key) => localStorage.getItem(key), APPEARANCE_KEY)
const themeColour = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((meta) => meta.content).join(' '))
/** The file a logo shows now: the browser's own choice among the picture's sources. */
const shownLogo = (scope: Locator) => scope.locator('img[data-company-logo]').first().evaluate((image: HTMLImageElement) => (image.currentSrc ? new URL(image.currentSrc).pathname : ''))
/** The appearance toggle in `scope`, by its name in `language`. */
const toggleIn = (scope: Page | Locator, language: keyof typeof DARK_MODE = 'en') => scope.getByRole('button', { name: DARK_MODE[language], exact: true })

async function expectScheme(page: Page, scheme: 'light' | 'dark') {
  await expect.poll(() => schemeOf(page)).toBe(scheme)
  await expect.poll(() => canvasOf(page)).toBe(CANVAS[scheme])
}

/** `frames: false`: the page alone, without a sandboxed frame, which runs no script (the saved e-mail; the server checks its own markup). */
async function expectNoAxeViolations(page: Page, what: string, { frames = true }: { frames?: boolean } = {}) {
  const builder = new AxeBuilder({ page })
  const results = await (frames ? builder : builder.exclude('iframe[sandbox]').options({ iframes: false })).analyze()
  const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
  expect(blocking.map((violation) => `${violation.id}: ${violation.nodes.map((node) => `${node.target.join(' ')} ${node.any[0]?.message ?? ''}`).join(', ')}`), `axe: ${what}`).toEqual([])
}

const horizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

/**
 * The mean brightness (0–255) of every frame the browser drew while `action` ran, read from Chromium's
 * screencast and measured in a page of its own.
 */
async function framesDrawn(page: Page, action: () => Promise<void>): Promise<number[]> {
  const cdp = await page.context().newCDPSession(page)
  const frames: string[] = []
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    frames.push(data)
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined)
  })
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 360, maxHeight: 360 })
  await action()
  await page.waitForTimeout(400)
  await cdp.send('Page.stopScreencast')
  await cdp.detach()
  const meter = await page.context().newPage()
  try {
    return await meter.evaluate(async (list) => {
      const means: number[] = []
      for (const data of list) {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const context = canvas.getContext('2d')!
        context.drawImage(bitmap, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let sum = 0
        for (let index = 0; index < pixels.length; index += 4) sum += (pixels[index]! + pixels[index + 1]! + pixels[index + 2]!) / 3
        means.push(Math.round(sum / (pixels.length / 4)))
      }
      return means
    }, frames)
  } finally {
    await meter.close()
  }
}

/** What a switch looks like: the toggle has the language switch's own. */
const lookOf = (element: Locator) =>
  element.evaluate((node) => {
    const style = getComputedStyle(node)
    return { edge: style.borderTopColor, edgeWidth: style.borderTopWidth, radius: style.borderTopLeftRadius, fill: style.backgroundColor, ink: style.color, height: node.getBoundingClientRect().height }
  })

/* The toggle on the signed-out pages ---------------------------------------------------------------- */

test('the signed-out pages offer the appearance as one toggle beside the language switch, by keyboard, in both languages', async ({ browser }, testInfo) => {
  const page = await openWith(browser, testInfo.project.use, { colorScheme: 'light' })
  await mockCompanyApi(page, { company: SAHARA })
  await page.goto('/login')
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible(FIRST_RENDER)

  const header = page.locator('[data-public-header]')
  const toggle = toggleIn(header)
  const language = header.locator('[data-language-switch]')
  // One toggle button, its name its tooltip, not pressed on a light device; nothing chosen yet.
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(toggle).toHaveAttribute('title', 'Dark mode')
  expect(await storedChoice(page)).toBeNull()
  // No words on screen: its only text is the name for assistive technology, and the symbol is the moon.
  expect(await toggle.evaluate((button) => [...button.querySelectorAll('*')].filter((node) => node.childElementCount === 0 && node.textContent?.trim()).map((node) => node.className))).toEqual(['sr-only'])
  await expect(toggle.locator('svg.lucide-moon')).toBeVisible()
  // On the language switch's inline-start side, the same row, 8 px apart; the language switch's size and look.
  const [toggleBox, languageBox] = [await toggle.boundingBox(), await language.boundingBox()]
  expect([toggleBox!.width, toggleBox!.height]).toEqual([44, 44])
  expect(Math.abs(toggleBox!.y - languageBox!.y)).toBeLessThanOrEqual(1)
  expect(languageBox!.x - (toggleBox!.x + toggleBox!.width)).toBeCloseTo(8, 0)
  expect(await lookOf(toggle)).toEqual(await lookOf(language))

  // By keyboard: the page's first stop, its ring on it; Enter and Space press it, and the focus stays.
  await page.keyboard.press('Tab')
  await expect(toggle).toBeFocused()
  expect(await toggle.evaluate((button) => [getComputedStyle(button).outlineStyle, getComputedStyle(button).outlineWidth])).toEqual(['solid', '2px'])
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expectScheme(page, 'dark')
  expect(await storedChoice(page)).toBe('dark')
  await expect(toggle).toBeFocused()
  await expect(toggle.locator('svg.lucide-sun')).toBeVisible()
  await expectNoAxeViolations(page, 'the sign-in page, Dark, English')
  await page.keyboard.press('Space')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expectScheme(page, 'light')
  expect(await storedChoice(page)).toBe('light')
  await page.keyboard.press('Tab')
  await expect(language).toBeFocused()

  // Arabic: «الوضع الداكن», still on the language switch's inline-start side: to its right.
  await language.click()
  const arabic = toggleIn(header, 'ar')
  await expect(arabic).toHaveAttribute('title', 'الوضع الداكن')
  const [arabicBox, englishBox] = [await arabic.boundingBox(), await language.boundingBox()]
  expect(arabicBox!.x - (englishBox!.x + englishBox!.width)).toBeCloseTo(8, 0)
  await arabic.click()
  await expectScheme(page, 'dark')
  await expectNoAxeViolations(page, 'the sign-in page, Dark, Arabic')
  await page.context().close()
})

/** WCAG 1.4.12's text spacing, as a person's own style sheet sets it. */
const TEXT_SPACING = '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }'

interface Box {
  left: number
  right: number
  top: number
  bottom: number
}
const meets = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
const within = (a: Box, b: Box) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5

/**
 * What is wrong with a public page's header now: the toggle over the language switch, anything outside
 * its own box (the symbol outside the toggle, either switch outside the header), the toggle off the
 * language switch's inline-start side, a target under 44 px, the language switch out of its corner, a
 * page that scrolls sideways. Also whether the two share a row.
 */
async function headerProblems(page: Page): Promise<{ problems: string[]; oneRow: boolean }> {
  const layout = await page.evaluate(() => {
    const toggle = document.querySelector('[data-appearance-toggle]')!
    const header = toggle.closest('header')!
    const [headerBox, toggleBox, languageBox, symbolBox] = [header, toggle, header.querySelector('[data-language-switch]')!, toggle.querySelector('svg')!].map((element) => {
      const { left, right, top, bottom } = element.getBoundingClientRect()
      return { left, right, top, bottom, spills: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1 }
    })
    return {
      header: headerBox!,
      toggle: toggleBox!,
      language: languageBox!,
      symbol: symbolBox!,
      rtl: getComputedStyle(header).direction === 'rtl',
      width: window.innerWidth,
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
  const { header, toggle, language, symbol } = layout
  const problems: string[] = []
  if (meets(toggle, language)) problems.push('the toggle covers the language switch')
  if (!within(symbol, toggle)) problems.push('the symbol outside the toggle')
  if (!within(toggle, header)) problems.push('the toggle outside the header')
  if (!within(language, header)) problems.push('the language switch outside the header')
  if (language.spills) problems.push('the language switch: its content outside it')
  for (const [name, box] of [['the toggle', toggle], ['the language switch', language]] as const) {
    if (box.right - box.left < 43.5 || box.bottom - box.top < 43.5) problems.push(`${name} under 44 px: ${(box.right - box.left).toFixed(1)} × ${(box.bottom - box.top).toFixed(1)}`)
  }
  const oneRow = Math.abs(toggle.top - language.top) <= 1
  if (oneRow && (layout.rtl ? toggle.left < language.right - 0.5 : toggle.right > language.left + 0.5)) problems.push('the toggle not on the language switch’s inline-start side')
  // The header within the screen (inside the page's gutter, which grows with the text size), and the language switch in its inline-end corner.
  if (header.left < 0 || header.right > layout.width) problems.push('the header outside the screen')
  const corner = layout.rtl ? language.left - header.left : header.right - language.right
  if (Math.abs(corner) > 1) problems.push(`the language switch ${corner.toFixed(1)} px from its corner`)
  if (layout.sideways > 0) problems.push(`the page scrolls sideways by ${layout.sideways} px`)
  return { problems, oneRow }
}

test('the toggle never covers the language switch: at 320 and 390 px, with a larger text size and WCAG text spacing, in both languages', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'It sets its own widths: once is enough')
  // A person's own style sheet is a style the page's policy (`style-src 'self'`) would refuse.
  const page = await openWith(browser, testInfo.project.use, { colorScheme: 'light', bypassCSP: true })
  await mockCompanyApi(page, { company: SAHARA })
  const styles = { plain: '', spacing: TEXT_SPACING, 'text at 20 px': 'html { font-size: 20px !important; }' } as const

  async function check(where: string) {
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 720 })
      for (const [style, css] of Object.entries(styles)) {
        const sheet = css ? await page.addStyleTag({ content: css }) : null
        const { problems, oneRow } = await headerProblems(page)
        const label = `${where}, ${await page.evaluate(() => document.documentElement.lang)}, ${width} px, ${style}`
        expect(problems, label).toEqual([])
        // Two buttons fit the narrowest header, whatever the text: always one row.
        expect(oneRow, `${label}: one row`).toBe(true)
        await sheet?.evaluate((element) => element.parentNode?.removeChild(element))
      }
    }
  }

  // The sign-in page (the layout of every signed-out page), English then Arabic.
  await page.goto('/login')
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible(FIRST_RENDER)
  await check('the sign-in page')
  await page.locator('[data-language-switch]').click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar')
  await check('the sign-in page')
  // The visitor's pass: a header of its own, Arabic (the device's choice) then English.
  await page.goto(`/pass?c=sahara#${PASS_TOKEN}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible(FIRST_RENDER)
  await expect(page.locator('html')).toHaveAttribute('lang', 'ar')
  await check('the pass')
  await page.locator('[data-language-switch]').click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await check('the pass')
  await page.context().close()
})

test('a press is kept on the device: across reloads, for every company and the platform’s area, and in another tab at once', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The device’s memory: once is enough')
  const page = await openWith(browser, testInfo.project.use, { colorScheme: 'light' })
  await mockCompanyApi(page, { company: SAHARA })
  await page.goto('/login')
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible(FIRST_RENDER)
  await toggleIn(page).click()
  await expectScheme(page, 'dark')
  expect(await storedChoice(page)).toBe('dark')

  for (const path of ['/login', '/c/sahara', '/forgot-password?c=sahara', '/platform/login']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible(FIRST_RENDER)
    await expectScheme(page, 'dark')
    await expect(toggleIn(page)).toHaveAttribute('aria-pressed', 'true')
  }

  // Another tab of the same browser follows a press made here, without a reload.
  const other = await page.context().newPage()
  await other.goto('/c/sahara')
  await expect(other.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible(FIRST_RENDER)
  await expectScheme(other, 'dark')
  await toggleIn(page).click()
  await expectScheme(other, 'light')
  await expect(toggleIn(other)).toHaveAttribute('aria-pressed', 'false')
  expect(await storedChoice(other)).toBe('light')
  await page.context().close()
})

test('until it is pressed the page follows the device live; a press keeps the other scheme than the one shown, whatever the device says', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The device’s scheme: once is enough')
  const page = await openWith(browser, testInfo.project.use, { colorScheme: 'light' })
  await mockCompanyApi(page, { company: SAHARA })
  await page.goto('/c/sahara')
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible(FIRST_RENDER)
  const toggle = toggleIn(page)
  await expectScheme(page, 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expectScheme(page, 'dark')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(await storedChoice(page)).toBeNull()

  // Dark is shown (the device's): a press keeps Light, and the device no longer decides.
  await toggle.click()
  await expectScheme(page, 'light')
  expect(await storedChoice(page)).toBe('light')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expectScheme(page, 'light')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await page.emulateMedia({ colorScheme: 'light' })
  await expectScheme(page, 'dark')
  expect(await storedChoice(page)).toBe('dark')
  await page.context().close()

  // A `system` kept by the build before the toggle is no choice: the device's scheme, live.
  const earlier = await openWith(browser, testInfo.project.use, { colorScheme: 'dark', ...stored(testInfo.project.use, 'system') })
  await mockCompanyApi(earlier, { company: SAHARA })
  await earlier.goto('/c/sahara')
  await expect(earlier.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible(FIRST_RENDER)
  await expectScheme(earlier, 'dark')
  await earlier.emulateMedia({ colorScheme: 'light' })
  await expectScheme(earlier, 'light')
  await expect(toggleIn(earlier)).toHaveAttribute('aria-pressed', 'false')
  await toggleIn(earlier).click()
  expect(await storedChoice(earlier)).toBe('dark')
  await earlier.context().close()
})

/* No flash --------------------------------------------------------------------------------------- */

test('a page with Dark stored is dark from its first frame, on a device in its light scheme: no white frame', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Chromium’s screencast: once is enough')
  const palette = mockPalette(SAHARA.colour!)
  const page = await openWith(browser, testInfo.project.use, { colorScheme: 'light', ...stored(testInfo.project.use, 'dark') })
  const files = await logos(page)
  await mockCompanyApi(page, { company: SAHARA, files, signedIn: 'en' })
  // What the root element carries when the browser draws its first frame, before the app and its stylesheet.
  await page.context().addInitScript(() => {
    requestAnimationFrame(() => {
      const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
      const chrome = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ;(window as unknown as { firstFrame: unknown }).firstFrame = { scheme: document.documentElement.getAttribute('data-scheme'), meta: meta?.content ?? null, chrome: chrome?.content ?? null }
    })
  })

  for (const path of ['/login', '/visits', `/pass?c=sahara#${PASS_TOKEN}`]) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible(FIRST_RENDER)
    // The browser's chrome too: the dark one already (a neutral page's, until the app gives the company's), never index.html's light teal.
    expect(await page.evaluate(() => (window as unknown as { firstFrame: unknown }).firstFrame), path).toEqual({ scheme: 'dark', meta: 'dark', chrome: expect.stringMatching(new RegExp(`^(#0f3b3f|${palette.deep})$`)) })
    // A reload: every frame the browser draws on the way is dark (a white frame measured 255 here).
    const means = await framesDrawn(page, async () => {
      await page.reload()
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible(FIRST_RENDER)
    })
    expect(means.length, path).toBeGreaterThan(0)
    expect(Math.max(...means), `${path}: the brightest frame of a reload (0-255)`).toBeLessThan(80)
  }
  await page.context().close()
})

/* Logos and the browser's chrome ------------------------------------------------------------------ */

/** What a logo's room on a page paints: its fill and its edge's colour. */
const roomPaint = (page: Page) =>
  page.locator('[data-identity-lockup="page"] [data-logo-room]').evaluate((room) => ({ fill: getComputedStyle(room).backgroundColor, edge: getComputedStyle(room).borderTopColor }))
const NOTHING = { fill: 'rgba(0, 0, 0, 0)', edge: 'rgba(0, 0, 0, 0)' }

test('logos and the browser chrome’s colour follow the choice, not the device; paper stays light', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === 'tablet', 'The phone and the desktop are enough here')
  const palette = mockPalette(SAHARA.colour!)
  // A device in its dark scheme whose person chose Light: everything light.
  const page = await openWith(browser, testInfo.project.use, { colorScheme: 'dark', ...stored(testInfo.project.use, 'light') })
  const files = await logos(page)
  await mockCompanyApi(page, { company: SAHARA, files })
  await page.goto('/c/sahara')
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible(FIRST_RENDER)
  await expectScheme(page, 'light')
  await expect.poll(() => shownLogo(page.locator('[data-identity-lockup="page"]'))).toBe('/api/v1/public/companies/sahara/brand/logo.png')
  await expect.poll(() => themeColour(page)).toBe(palette.surface)
  // On the page itself: no plate in the light scheme (F13-26).
  expect(await roomPaint(page)).toEqual(NOTHING)

  // Dark: the logo for dark surfaces, never on a plate; the chrome takes the deep step.
  await toggleIn(page).click()
  await expect.poll(() => shownLogo(page.locator('[data-identity-lockup="page"]'))).toBe('/api/v1/public/companies/sahara/brand/logo_dark.png')
  await expect.poll(() => themeColour(page)).toBe(palette.deep)
  expect(await roomPaint(page)).toEqual(NOTHING)
  await expectNoAxeViolations(page, 'a company’s sign-in page, Dark')

  // On paper the pass is light whatever the screen: the logo for light surfaces on white.
  await page.goto(`/pass?c=sahara#${PASS_TOKEN}`)
  await expect(page.getByRole('img', { name: 'Visitor pass QR code' })).toBeVisible(FIRST_RENDER)
  await expect.poll(() => shownLogo(page.locator('[data-identity-lockup="page"]'))).toBe('/api/v1/public/companies/sahara/brand/logo_dark.png')
  await page.emulateMedia({ media: 'print' })
  await expect.poll(() => canvasOf(page)).toBe('rgb(255, 255, 255)')
  await expect.poll(() => shownLogo(page.locator('[data-identity-lockup="paper"]'))).toBe('/api/v1/public/companies/sahara/brand/logo.png')
  await page.emulateMedia({ media: 'screen' })
  await page.context().close()
})

/** The colour of the pixel at a share of a screenshot's width and height, read back in a page of its own. */
async function pixelOf(page: Page, png: Buffer, u: number, v: number): Promise<number[]> {
  const meter = await page.context().newPage()
  try {
    return await meter.evaluate(
      async ({ data, at }) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const context = canvas.getContext('2d')!
        context.drawImage(bitmap, 0, 0)
        return Array.from(context.getImageData(Math.floor(at[0] * bitmap.width), Math.floor(at[1] * bitmap.height), 1, 1).data).slice(0, 3)
      },
      { data: png.toString('base64'), at: [u, v] },
    )
  } finally {
    await meter.close()
  }
}

/** Where everything a press could move stands: the switches, the logo's room, the card. */
const placesOf = (page: Page) =>
  page.evaluate(() =>
    ['[data-appearance-toggle]', '[data-language-switch]', '[data-identity-lockup="page"] [data-logo-room]', 'main form, main article'].map((selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect()
      return box ? [selector, Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)].join(' ') : `${selector}: none`
    }),
  )

test('a logo stands on the page itself in the light scheme; a plate only for a logo for light surfaces in the dark one; nothing else moves', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === 'tablet', 'The phone and the desktop are enough here')
  for (const [what, darkLogo] of [
    ['the bank, with its mark for dark surfaces', true],
    ['the bank, with its logo for light surfaces only', false],
  ] as const) {
    const page = await openWith(browser, testInfo.project.use, { colorScheme: 'light' })
    const files = await bankLogos(page, { dark: darkLogo })
    await mockCompanyApi(page, { company: BANK, files })
    for (const [where, address] of [
      ['sign in', `/c/${BANK.slug}`],
      ['the pass', `/pass?c=${BANK.slug}#${PASS_TOKEN}`],
    ] as const) {
      const label = `${what}, ${where}`
      await page.goto(address)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible(FIRST_RENDER)
      await expectScheme(page, 'light')
      const room = page.locator('[data-identity-lockup="page"] [data-logo-room]')
      await expect.poll(() => room.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), label).toBe(true)
      // The light scheme: the logo on the page, nothing painted around it. A corner of its room is the page's own canvas,
      // and so is the room's edge: the owner's "the logo has a background" is gone.
      expect(await roomPaint(page), label).toEqual(NOTHING)
      const shot = await room.screenshot()
      for (const [u, v] of [[0.01, 0.03], [0.99, 0.97], [0.5, 0.01]] as const) expect(await pixelOf(page, shot, u, v), `${label}: the room at ${u}, ${v}`).toEqual([241, 241, 241])
      // Its own opaque white pixels are the logo's, inside the diamond: drawn as they are.
      const [roomBox, imageBox] = [await room.boundingBox(), await room.locator('img').boundingBox()]
      const inside = [(imageBox!.x - roomBox!.x + (62 / 609) * imageBox!.width) / roomBox!.width, (imageBox!.y - roomBox!.y + (80 / 159) * imageBox!.height) / roomBox!.height] as const
      expect((await pixelOf(page, shot, inside[0], inside[1])).every((channel) => channel >= 240), `${label}: the white inside the diamond`).toBe(true)
      const before = await placesOf(page)

      await toggleIn(page).click()
      await expectScheme(page, 'dark')
      if (darkLogo) {
        // The mark for dark surfaces, never on a plate, with the company's name beside it (an emblem).
        await expect.poll(() => shownLogo(page.locator('[data-identity-lockup="page"]')), label).toBe(`/api/v1/public/companies/${BANK.slug}/brand/logo_dark.png`)
        await expect(page.locator('[data-identity-lockup="page"] [data-company-name]'), label).toHaveText(BANK.name)
        expect(await roomPaint(page), label).toEqual(NOTHING)
      } else {
        // A logo for light surfaces on the dark page: on its white plate with the cards' edge, in the same room.
        const edge = await page.evaluate(() => {
          const probe = document.createElement('i')
          probe.className = 'border border-border'
          document.body.append(probe)
          const colour = getComputedStyle(probe).borderTopColor
          probe.remove()
          return colour
        })
        expect(await roomPaint(page), label).toEqual({ fill: 'rgb(255, 255, 255)', edge })
      }
      // Nothing moved but the logo itself: the switches, the card and, for one logo, its room are where they were.
      const after = await placesOf(page)
      expect(after.filter((place) => !place.startsWith('[data-identity-lockup') || !darkLogo), label).toEqual(before.filter((place) => !place.startsWith('[data-identity-lockup') || !darkLogo))
      expect(await horizontalOverflow(page), label).toBeLessThanOrEqual(0)
      await expectNoAxeViolations(page, `${label}, Dark`)
      // Back to light for the next page.
      await toggleIn(page).click()
      await expectScheme(page, 'light')
    }
    await page.context().close()
  }
})

test('a light colour’s shell: its logo on the plate in the light scheme, the deep shell with the logo for dark surfaces in the dark one', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === 'tablet', 'The phone and the desktop are enough here')
  const palette = mockPalette(SAHARA.colour!)
  const page = await openWith(browser, testInfo.project.use, { colorScheme: 'light' })
  const files = await logos(page)
  await mockCompanyApi(page, { company: SAHARA, files, signedIn: 'en' })
  await page.goto('/visits')
  await expect(page.getByRole('heading', { level: 1, name: 'My visits' })).toBeVisible(FIRST_RENDER)
  const shell = page.locator('aside:visible, header[data-app-bar]:visible').first()
  await expect.poll(() => shell.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(245, 184, 0)')
  await expect.poll(() => shownLogo(shell)).toBe('/api/v1/public/companies/sahara/brand/logo.png')

  await page.evaluate((key) => {
    localStorage.setItem(key, 'dark')
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: 'dark' }))
  }, APPEARANCE_KEY)
  await expectScheme(page, 'dark')
  const deep = await page.evaluate((hex) => {
    const probe = document.createElement('i')
    probe.style.color = hex
    document.body.append(probe)
    const colour = getComputedStyle(probe).color
    probe.remove()
    return colour
  }, palette.deep)
  await expect.poll(() => shell.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(deep)
  await expect.poll(() => shownLogo(shell)).toBe('/api/v1/public/companies/sahara/brand/logo_dark.png')
  await expectNoAxeViolations(page, 'my visits, Dark, a yellow company')
  await page.context().close()
})

/* The shells ---------------------------------------------------------------------------------------- */

async function openAccountMenu(page: Page, name: string) {
  const trigger = page.getByRole('button', { name: `Account menu for ${name}` })
  await trigger.focus()
  await page.keyboard.press('Enter')
  return { trigger, menu: page.getByRole('menu', { name: `Account menu for ${name}` }) }
}

/** The toggle in a shell: beside its language switch, on its inline-start side, the same size and look. */
async function expectToggleBesideLanguage(shell: Locator, what: string, uiLanguage: keyof typeof DARK_MODE = 'en') {
  const toggle = toggleIn(shell, uiLanguage)
  const language = shell.locator('[data-language-switch]')
  await expect(toggle, what).toBeVisible()
  const [toggleBox, languageBox] = [await toggle.boundingBox(), await language.boundingBox()]
  expect([toggleBox!.width, toggleBox!.height], what).toEqual([44, 44])
  expect(Math.abs(toggleBox!.y - languageBox!.y), what).toBeLessThanOrEqual(1)
  // On the language switch's inline-start side, the bar's gap apart: 8 px, 6 px below 384 px.
  const rtl = await shell.evaluate((element) => getComputedStyle(element).direction === 'rtl')
  const gap = rtl ? toggleBox!.x - (languageBox!.x + languageBox!.width) : languageBox!.x - (toggleBox!.x + toggleBox!.width)
  expect(gap === 6 || gap === 8, `${what}: ${gap} px apart`).toBe(true)
  expect(await lookOf(toggle), what).toEqual(await lookOf(language))
}

test('the shells carry the toggle beside the language switch, and the account menus no appearance', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === 'tablet', 'The phone and the desktop are enough here')
  const page = await openWith(browser, testInfo.project.use, { colorScheme: 'light' })
  await mockCompanyApi(page, { company: SAHARA, signedIn: 'en', platform: 'en', extra: (path, route) => (path === '/platform/companies' ? route.fulfill({ json: { items: [platformCompanyOf(SAHARA)], page: 1, page_size: 25, total: 1 } }) : undefined) })
  await page.goto('/visits')
  await expect(page.getByRole('heading', { level: 1, name: 'My visits' })).toBeVisible(FIRST_RENDER)
  // The sidebar's head on a desktop, the top bar on a phone.
  const shell = page.locator('aside:visible, header[data-app-bar]:visible').first()
  await expectToggleBesideLanguage(shell, 'the company’s shell')
  await expect(toggleIn(shell)).toHaveAttribute('aria-pressed', 'false')

  // The account menu: change password and sign out, nothing of the appearance.
  const { trigger, menu } = await openAccountMenu(page, 'Lina Haddad')
  await expect(menu.getByRole('menuitem')).toHaveText(['Change password', 'Sign out'])
  await expect(menu.getByRole('group')).toHaveCount(0)
  await expect(menu.getByRole('menuitemradio')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()

  await toggleIn(shell).click()
  await expectScheme(page, 'dark')
  await expect(toggleIn(shell)).toHaveAttribute('aria-pressed', 'true')
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0)
  await expectNoAxeViolations(page, 'my visits, Dark, from the shell’s toggle')
  await toggleIn(shell).click()
  await expectScheme(page, 'light')

  // The platform owner's shell: the same toggle, for the same device.
  await page.goto('/platform/companies')
  await expect(page.getByRole('heading', { level: 1, name: 'Companies' })).toBeVisible(FIRST_RENDER)
  const platformShell = page.locator('aside:visible, header[data-app-bar]:visible').first()
  await expectToggleBesideLanguage(platformShell, 'the platform’s shell')
  await expect(toggleIn(platformShell)).toHaveAttribute('aria-pressed', 'false')
  const platform = await openAccountMenu(page, 'Platform Owner')
  await expect(platform.menu.getByRole('menuitem')).toHaveText(['Change password', 'Sign out'])
  await expect(platform.menu.getByRole('menuitemradio')).toHaveCount(0)
  await page.keyboard.press('Escape')
  // The browser's chrome is the platform's own shell: the deep teal, the slate in the dark scheme.
  await expect.poll(() => themeColour(page)).toBe('#0f3b3f')
  await toggleIn(platformShell).click()
  await expectScheme(page, 'dark')
  await expect.poll(() => themeColour(page)).toBe('#33444e')
  // The platform's shell in the dark scheme is the slate, never a company's deep teal.
  await expect.poll(() => platformShell.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(51, 68, 78)')
  await expectNoAxeViolations(page, 'the platform’s companies, Dark')
  await page.context().close()
})

test('on a phone of 320 px the top bar holds its menu button, the lockup, both switches and the account menu, nothing over another', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'A phone’s width')
  for (const language of ['en', 'ar'] as const) {
    for (const [what, company, filesOf, area] of [
      ['the bank', BANK, (page: Page) => bankLogos(page), '/visits'],
      ['a yellow company with one wide logo', SAHARA, async (page: Page) => ({ logo: (await logos(page)).logo }), '/visits'],
      ['the platform', SAHARA, async () => ({}), '/platform/companies'],
    ] as const) {
      const page = await openWith(browser, testInfo.project.use, { colorScheme: 'light', viewport: { width: 320, height: 720 }, locale: language === 'ar' ? 'ar-JO' : 'en-US' })
      const files = await filesOf(page)
      await mockCompanyApi(page, { company, files, signedIn: language, platform: language, extra: (path, route) => (path === '/platform/companies' ? route.fulfill({ json: { items: [platformCompanyOf(SAHARA)], page: 1, page_size: 25, total: 1 } }) : undefined) })
      await page.goto(area)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible(FIRST_RENDER)
      const label = `${what}, ${language}`
      const bar = page.locator('header[data-app-bar]')
      await expectToggleBesideLanguage(bar, label, language)
      // Every control and the lockup inside the bar, none over another; the account menu a 44 px target.
      const boxes = await bar.evaluate((element) =>
        [...element.querySelectorAll('[data-identity-lockup], [data-brand-logo], [data-platform-tag], button')]
          .filter((node) => !node.parentElement?.closest('[data-identity-lockup]'))
          .map((node) => {
            const { left, right, top, bottom, width } = node.getBoundingClientRect()
            return { name: node.getAttribute('aria-label') ?? node.getAttribute('data-brand-logo') ?? node.textContent?.trim() ?? node.tagName, left, right, top, bottom, width }
          })
          .filter((box) => box.width > 0),
      )
      const barBox = await bar.boundingBox()
      for (const [index, box] of boxes.entries()) {
        expect(box.left >= barBox!.x - 0.5 && box.right <= barBox!.x + barBox!.width + 0.5, `${label}: ${box.name} inside the bar`).toBe(true)
        for (const other of boxes.slice(index + 1)) {
          if (other.name === box.name) continue
          const inside = (a: Box, b: Box) => a.left >= b.left && a.right <= b.right
          if (inside(other, box) || inside(box, other)) continue
          expect(meets(box, other), `${label}: ${box.name} over ${other.name}`).toBe(false)
        }
      }
      const account = await bar.locator('button[aria-haspopup="menu"]').boundingBox()
      expect(account!.width).toBeGreaterThanOrEqual(44)
      // The lockup's picture keeps its proportions where it gives way.
      const picture = bar.locator('[data-identity-lockup] img').first()
      if ((await picture.count()) > 0) {
        const ratio = await picture.evaluate((image: HTMLImageElement) => image.getBoundingClientRect().width / image.getBoundingClientRect().height / (image.naturalWidth / image.naturalHeight))
        expect(Math.abs(ratio - 1), `${label}: the logo in its proportions`).toBeLessThan(0.05)
      }
      expect(await horizontalOverflow(page), label).toBeLessThanOrEqual(0)
      await page.context().close()
    }
  }
})

/* Forced colours ----------------------------------------------------------------------------------- */

/** The share (0–1) of a picture's pixels that are `colour` (a computed `rgb(…)`), each channel within 8. */
async function shareOf(page: Page, png: Buffer, colour: string): Promise<number> {
  const target = colour.match(/\d+/g)!.slice(0, 3).map(Number)
  const meter = await page.context().newPage()
  try {
    return await meter.evaluate(
      async ({ data, channels }) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const context = canvas.getContext('2d')!
        context.drawImage(bitmap, 0, 0)
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
        let matching = 0
        for (let index = 0; index < pixels.length; index += 4) if ([0, 1, 2].every((channel) => Math.abs(pixels[index + channel]! - channels[channel]!) <= 8)) matching += 1
        return matching / (pixels.length / 4)
      },
      { data: png.toString('base64'), channels: target },
    )
  } finally {
    await meter.close()
  }
}

const paintOf = (element: Locator) => element.evaluate((node) => ({ background: getComputedStyle(node).backgroundColor, colour: getComputedStyle(node).color, edge: getComputedStyle(node).borderTopColor }))

/**
 * In a forced-colours mode every fill is the system's: the toggle's state was never its fill but its
 * symbol, which is drawn in the system's text colour, inside an edge of that colour.
 */
async function expectToggleShows(page: Page, toggle: Locator, symbol: 'sun' | 'moon', what: string) {
  await expect(toggle.locator(`svg.lucide-${symbol}`), what).toBeVisible()
  const paint = await paintOf(toggle)
  expect(paint.colour, `${what}: its symbol on its fill`).not.toBe(paint.background)
  expect(paint.edge, `${what}: its edge on its fill`).not.toBe(paint.background)
  // On screen: the symbol is drawn in that colour.
  expect(await shareOf(page, await toggle.locator('svg').screenshot(), paint.colour), `${what}: the symbol drawn`).toBeGreaterThan(0.02)
}

test('in a forced-colours mode (Windows’ contrast themes) the toggle, its state and its focus ring show, on a page and in the shell', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Chromium’s forced colours: once is enough')
  const page = await openWith(browser, testInfo.project.use, { colorScheme: 'light', forcedColors: 'active', ...stored(testInfo.project.use, 'dark') })
  await mockCompanyApi(page, { company: SAHARA, signedIn: 'en' })
  // The toggle beside the language switch (the pass's header: a page of its own, signed in or not).
  await page.goto(`/pass?c=sahara#${PASS_TOKEN}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible(FIRST_RENDER)
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true)
  const toggle = toggleIn(page)
  await expectToggleShows(page, toggle, 'sun', 'the pass, Dark')
  await page.keyboard.press('Tab')
  await expect(toggle).toBeFocused()
  const ring = await toggle.evaluate((button) => ({ style: getComputedStyle(button).outlineStyle, colour: getComputedStyle(button).outlineColor, page: getComputedStyle(document.body).backgroundColor }))
  expect(ring.style).toBe('solid')
  expect(ring.colour, 'the focus ring on the page').not.toBe(ring.page)
  await page.keyboard.press('Space')
  // The page's own canvas is the system's Canvas here: the scheme on the root says the press was made.
  await expect.poll(() => schemeOf(page)).toBe('light')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expectToggleShows(page, toggle, 'moon', 'the pass, Light')

  // The shell's toggle.
  await page.goto('/visits')
  await expect(page.getByRole('heading', { level: 1, name: 'My visits' })).toBeVisible(FIRST_RENDER)
  await expectToggleShows(page, toggleIn(page.locator('aside')), 'moon', 'the sidebar, Light')
  await page.context().close()
})

/* The reception screen ----------------------------------------------------------------------------- */

const TODAY: ReceptionToday = {
  date: new Date().toISOString().slice(0, 10),
  counts: { expected: 2, inside: 1, checked_out: 0, no_show: 0, cancelled: 0, walk_ins: 0 },
  expected: MOCK_VISITS.slice(1),
  inside: MOCK_VISITS.slice(0, 1),
  checked_out: [],
  no_show: [],
}

const receptionApi = (company: MockCompany): MockApiOptions => ({
  company,
  signedIn: 'en',
  extra: (path, route) => {
    if (path === '/reception/today') return route.fulfill({ json: TODAY })
    if (path === '/reception/inside') return route.fulfill({ json: { count: 1, items: MOCK_VISITS.slice(0, 1) } })
    return undefined
  },
})

test('the reception screen: dark with nothing chosen as before, light for a device that chose Light, dark for Dark; the toggle says what is shown; its camera panel dark in all three', async ({ browser }, testInfo) => {
  // Three devices, each with four tabs under axe: more than the project's minute when the suite runs in parallel.
  test.setTimeout(180_000)
  for (const [appearance, device, expected] of [
    [null, 'light', 'dark'],
    ['light', 'dark', 'light'],
    ['dark', 'light', 'dark'],
  ] as const) {
    const page = await openWith(browser, testInfo.project.use, { colorScheme: device, ...(appearance ? stored(testInfo.project.use, appearance) : {}) })
    await mockCompanyApi(page, receptionApi(SAHARA))
    await page.goto('/reception')
    await expect(page.getByText('Ready to scan')).toBeVisible(FIRST_RENDER)
    const label = `${appearance ?? 'nothing chosen'} on a ${device} device`
    await expect.poll(() => page.locator('[data-surface="dark"]').count(), label).toBe(expected === 'dark' ? 1 : 0)
    await expect.poll(() => canvasOf(page), label).toBe(CANVAS[expected])
    // The shell: the company's own (yellow) for Light, the deep one around the dark screen.
    const shell = page.locator('aside:visible, header[data-app-bar]:visible').first()
    const shellColour = await shell.evaluate((element) => getComputedStyle(element).backgroundColor)
    if (expected === 'light') expect(shellColour, label).toBe('rgb(245, 184, 0)')
    else expect(shellColour, label).not.toBe('rgb(245, 184, 0)')
    // The toggle says what is shown: dark on the dark screen also while the page's own scheme is light.
    await expect(toggleIn(shell), label).toHaveAttribute('aria-pressed', String(expected === 'dark'))
    // The camera's panel shows a live picture of any brightness: the same dark panel in both schemes.
    await expect.poll(() => page.locator('.bg-media').first().evaluate((panel) => getComputedStyle(panel).backgroundColor), label).toBe('rgb(14, 19, 22)')
    await expectNoAxeViolations(page, `the reception, ${label}`)
    for (const tab of ['Expected', 'Inside', 'Walk-in']) {
      await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click()
      await expect(page.getByRole('tab', { name: new RegExp(`^${tab}`) })).toHaveAttribute('aria-selected', 'true')
      // The tabs' colours fade for 150 ms: axe reads them once they have.
      await page.waitForFunction(() => document.getAnimations().every((animation) => !(animation instanceof CSSTransition)))
      await expectNoAxeViolations(page, `the reception's ${tab} tab, ${label}`)
    }
    expect(await horizontalOverflow(page), label).toBeLessThanOrEqual(0)
    if (appearance === null) {
      // Dark is shown: a press keeps Light, and the reception is drawn light; the next press, Dark.
      await toggleIn(shell).click()
      await expect.poll(() => page.locator('[data-surface="dark"]').count(), `${label}, pressed`).toBe(0)
      await expect.poll(() => canvasOf(page), `${label}, pressed`).toBe(CANVAS.light)
      expect(await storedChoice(page)).toBe('light')
      await toggleIn(page.locator('aside:visible, header[data-app-bar]:visible').first()).click()
      await expect.poll(() => page.locator('[data-surface="dark"]').count(), `${label}, pressed twice`).toBe(1)
      expect(await storedChoice(page)).toBe('dark')
    }
    await page.context().close()
  }
})

/** An e-mail's texts as the editor reads them: three fields, nothing changed. */
const field = (name: 'subject' | 'heading' | 'intro', multiline: boolean, en: string): EmailTemplate['fields'][number] => ({
  name,
  multiline,
  max_length: 1000,
  required_variables: name === 'subject' ? ['company'] : [],
  forbidden_variables: [],
  default: { ar: 'زيارتك إلى {company}', en },
  override: { ar: null, en: null },
})

const TEMPLATE: EmailTemplate = {
  kind: 'VISITOR_INVITATION',
  variables: ['visitor_name', 'company', 'host_name', 'date', 'time', 'timezone', 'department', 'purpose'],
  max_variable_uses: 3,
  updated_at: null,
  fields: [field('subject', false, 'Your visit to {company}'), field('heading', false, 'Your visit to {company}'), field('intro', true, 'You are invited.')],
}

/* The e-mail previews ------------------------------------------------------------------------------- */

test('the e-mail texts editor shows the saved e-mail Light or Dark, Light first, whatever the app’s own scheme', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === 'tablet', 'The phone and the desktop are enough here')
  const asked: string[] = []
  const drafts: unknown[] = []
  const page = await openWith(browser, testInfo.project.use, { colorScheme: 'dark' })
  await mockCompanyApi(page, {
    company: SAHARA,
    signedIn: 'en',
    extra: (path, route) => {
      const url = new URL(route.request().url())
      if (path === '/email-templates/VISITOR_INVITATION' && route.request().method() === 'GET') return route.fulfill({ json: TEMPLATE })
      if (path === '/email-templates/VISITOR_INVITATION/preview' && route.request().method() === 'POST') {
        drafts.push(route.request().postDataJSON())
        return route.fulfill({ json: { kind: 'VISITOR_INVITATION', language: 'en', subject: 'Your visit to Sahara Sun Hotels', html: '<!DOCTYPE html><html></html>', text: 'Sahara Sun Hotels' } })
      }
      if (path === '/email-templates/VISITOR_INVITATION/preview') {
        asked.push(url.search)
        const scheme = url.searchParams.get('scheme')
        return route.fulfill({ contentType: 'text/html', body: `<!DOCTYPE html><html><body style="margin:0;background:${scheme === 'dark' ? '#101619' : '#ffffff'}"><p>${scheme}</p></body></html>` })
      }
      return undefined
    },
  })
  await page.goto('/admin/email-templates/VISITOR_INVITATION')
  await expect(page.getByRole('heading', { level: 1, name: 'Visitor invitation' })).toBeVisible(FIRST_RENDER)
  await expectScheme(page, 'dark')
  // The draft's answer first: a request the page leaves before its answer is cancelled, and asked again on return.
  await expect(page.locator('[data-preview-subject]')).toHaveText('Your visit to Sahara Sun Hotels')
  await page.getByRole('tab', { name: 'Saved email' }).click()
  const schemes = page.getByRole('radiogroup', { name: 'Email appearance' })
  await expect(schemes.getByRole('radio')).toHaveCount(2)
  await expect(schemes.getByRole('radio', { name: 'Light' })).toBeChecked()
  const frame = page.locator('iframe[data-saved-preview]')
  await expect(frame).toHaveAttribute('src', /scheme=light$/)
  expect(await frame.evaluate((element) => getComputedStyle(element).colorScheme)).toBe('light')
  await expect(page.frameLocator('iframe[data-saved-preview]').locator('p')).toHaveText('light')
  await expectNoAxeViolations(page, 'the saved e-mail, Light, in a dark app', { frames: false })

  await schemes.getByText('Dark', { exact: true }).click()
  await expect(frame).toHaveAttribute('src', /scheme=dark$/)
  expect(await frame.evaluate((element) => getComputedStyle(element).colorScheme)).toBe('dark')
  await expect(page.frameLocator('iframe[data-saved-preview]').locator('p')).toHaveText('dark')
  expect(asked).toEqual(['?language=en&scheme=light', '?language=en&scheme=dark'])

  // The draft (its subject and text version, no colours) is asked for without a scheme: back on it after
  // Dark, it is there at once and nothing is asked again.
  const draftsSoFar = drafts.length
  await page.getByRole('tab', { name: 'Draft' }).click()
  await expect(page.locator('[data-preview-subject]')).toHaveText('Your visit to Sahara Sun Hotels')
  await page.waitForTimeout(900)
  expect(drafts).toHaveLength(draftsSoFar)
  for (const draft of drafts) expect(draft).not.toHaveProperty('scheme')
  await page.context().close()
})

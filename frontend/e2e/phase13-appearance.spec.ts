import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Browser, type BrowserContextOptions, type Locator, type Page } from '@playwright/test'
import type { EmailTemplate, ReceptionToday } from '../src/types/api.ts'
import { mockPalette } from './support/mock-brand.ts'
import { drawFile, MOCK_VISITS, mockCompanyApi, platformCompanyOf, type MockApiOptions, type MockCompany, type MockFiles } from './support/mock-company.ts'

/*
 * The device's appearance in the browser (Phase 13, decisions F13-1 on): Light, Dark or System, what
 * jsdom cannot show. The API is mocked, so this spec needs only the Vite server.
 *
 * - The switch beside the language switch on the signed-out pages (a radio group of three) and in the
 *   account menus (a group of menuitemradio): its names, its keys, both languages, every width.
 * - The choice is kept on the device: across reloads, on every company's pages and the platform's,
 *   and in another tab at once; under System the device's own scheme is followed live.
 * - A page with Dark stored is dark from its first frame: the scheme is on the root element before
 *   anything is drawn, and no frame of a reload is white.
 * - The logos and the browser chrome's colour follow the choice, not the device; paper stays light.
 * - The reception screen is dark under System as before and follows an explicit choice; its camera
 *   panel is the dark panel in both.
 */

const FIRST_RENDER = { timeout: 30_000 }
const APPEARANCE_KEY = 'vms.appearance'
const PASS_TOKEN = 'rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2AXo3_vK9-aQ2'

/** A yellow company: a light shell under dark ink, the deep shell and its logo for dark surfaces in the dark scheme. */
const SAHARA: MockCompany = { slug: 'sahara', name: 'Sahara Sun Hotels', name_ar: 'فنادق شمس الصحراء', colour: '#f5b800' }

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

const schemeOf = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-scheme'))
const canvasOf = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
const themeColour = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((meta) => meta.content).join(' '))
/** The file a logo shows now: the browser's own choice among the picture's sources. */
const shownLogo = (scope: Locator) => scope.locator('img[data-company-logo]').first().evaluate((image: HTMLImageElement) => (image.currentSrc ? new URL(image.currentSrc).pathname : ''))

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

/* The switch on the signed-out pages --------------------------------------------------------------- */

test('the signed-out pages offer the appearance beside the language switch: a radio group of three, by keyboard, in both languages', async ({ browser }, testInfo) => {
  const page = await openWith(browser, testInfo.project.use, { colorScheme: 'light' })
  await mockCompanyApi(page, { company: SAHARA })
  await page.goto('/login')
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible(FIRST_RENDER)

  const group = page.getByRole('radiogroup', { name: 'Appearance' })
  await expect(group.getByRole('radio')).toHaveCount(3)
  for (const [name, checked] of [['Light', false], ['Dark', false], ['System', true]] as const) {
    if (checked) await expect(group.getByRole('radio', { name })).toBeChecked()
    else await expect(group.getByRole('radio', { name })).not.toBeChecked()
  }
  // Beside the language switch, in the page's top inline-end corner, as tall as it: no words besides the three.
  const header = page.locator('[data-public-header]')
  const [switchBox, languageBox] = [await header.locator('[data-appearance-switch] > div').boundingBox(), await header.locator('[data-language-switch]').boundingBox()]
  expect(switchBox && languageBox && Math.abs(switchBox.y - languageBox.y)).toBeLessThanOrEqual(1)
  expect(switchBox?.height).toBe(44)
  await expect(header.locator('[data-appearance-switch] > div')).toHaveText('LightDarkSystem')

  // One tab stop: the checked choice; the arrows move and choose in the reading direction.
  await page.keyboard.press('Tab')
  await expect(group.getByRole('radio', { name: 'System' })).toBeFocused()
  // Its ring is drawn on its segment, the radio itself being hidden.
  expect(await group.getByRole('radio', { name: 'System' }).evaluate((input) => getComputedStyle(input.closest('label')!).outlineStyle)).toBe('solid')
  await page.keyboard.press('ArrowLeft')
  await expect(group.getByRole('radio', { name: 'Dark' })).toBeChecked()
  await expectScheme(page, 'dark')
  await page.keyboard.press('Tab')
  await expect(page.locator('[data-language-switch]')).toBeFocused()
  await expectNoAxeViolations(page, 'the sign-in page, Dark, English')

  // Arabic: «المظهر»: «فاتح» «داكن» «تلقائي», right to left: the next choice lies to the left.
  await page.locator('[data-language-switch]').click()
  const arabic = page.getByRole('radiogroup', { name: 'المظهر' })
  await expect(arabic).toBeVisible()
  await expect(page.locator('[data-appearance-switch] > div')).toHaveText('فاتحداكنتلقائي')
  await arabic.getByRole('radio', { name: 'داكن' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(arabic.getByRole('radio', { name: 'فاتح' })).toBeChecked()
  await expectScheme(page, 'light')
  await expectNoAxeViolations(page, 'the sign-in page, Light, Arabic')
  // Narrow screens, a larger text size and wider text spacing, in both languages: the next test.
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
 * What is wrong with a public page's header now: a segment of the appearance over the language switch,
 * anything outside its own box (a segment's word outside its segment, a segment outside its group, the
 * group or the language switch outside the header), the language switch out of its corner, a page
 * that scrolls sideways. Also whether the two share a row.
 */
async function headerProblems(page: Page): Promise<{ problems: string[]; oneRow: boolean }> {
  const layout = await page.evaluate(() => {
    const group = document.querySelector('[data-appearance-switch]')!
    const header = group.closest('header')!
    const labels = [...group.querySelectorAll('label')]
    const [headerBox, groupBox, languageBox, ...segmentBoxes] = [header, group, header.querySelector('[data-language-switch]')!, ...labels].map((element) => {
      const { left, right, top, bottom } = element.getBoundingClientRect()
      return { left, right, top, bottom, spills: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1 }
    })
    return {
      header: headerBox!,
      group: groupBox!,
      language: languageBox!,
      segments: segmentBoxes.map((box, index) => ({ name: labels[index]!.textContent ?? '', ...box })),
      rtl: getComputedStyle(header).direction === 'rtl',
      width: window.innerWidth,
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
  const { header, group, segments, language } = layout
  const problems: string[] = []
  for (const segment of segments) {
    if (meets(segment, language)) problems.push(`${segment.name} covers the language switch`)
    if (!within(segment, group)) problems.push(`${segment.name} outside its group`)
    if (segment.spills) problems.push(`${segment.name}: its content outside its segment`)
  }
  if (!within(group, header)) problems.push('the group outside the header')
  if (!within(language, header)) problems.push('the language switch outside the header')
  if (language.spills) problems.push('the language switch: its content outside it')
  // The three in one row wherever one row of the header holds them (each overlaps the one before by its 1 px edge).
  const rowWidth = segments.reduce((sum, segment) => sum + segment.right - segment.left - 1, 1)
  if (new Set(segments.map((segment) => Math.round(segment.top))).size > 1 && rowWidth <= header.right - header.left + 0.5) {
    problems.push(`the segments wrap, though their ${rowWidth.toFixed(1)} px fit the header's ${(header.right - header.left).toFixed(1)}`)
  }
  // The header within the screen (inside the page's gutter, which grows with the text size), and the language switch in its inline-end corner.
  if (header.left < 0 || header.right > layout.width) problems.push('the header outside the screen')
  const corner = layout.rtl ? language.left - header.left : header.right - language.right
  if (Math.abs(corner) > 1) problems.push(`the language switch ${corner.toFixed(1)} px from its corner`)
  if (layout.sideways > 0) problems.push(`the page scrolls sideways by ${layout.sideways} px`)
  return { problems, oneRow: Math.abs(group.top - language.top) <= 1 }
}

test('the appearance never covers the language switch: at 320 and 390 px, with a larger text size and WCAG text spacing, in both languages', async ({ browser }, testInfo) => {
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
        // The design as it was where both fit: one row at a phone's width with the browser's own text.
        if (width === 390 && style === 'plain') expect(oneRow, `${label}: one row`).toBe(true)
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

test('the choice is kept on the device: across reloads, for every company and the platform’s area, and in another tab at once', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The device’s memory: once is enough')
  const page = await openWith(browser, testInfo.project.use, { colorScheme: 'light' })
  await mockCompanyApi(page, { company: SAHARA })
  await page.goto('/login')
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible(FIRST_RENDER)
  await page.getByText('Dark', { exact: true }).click()
  await expectScheme(page, 'dark')
  expect(await page.evaluate((key) => localStorage.getItem(key), APPEARANCE_KEY)).toBe('dark')

  for (const path of ['/login', '/c/sahara', '/forgot-password?c=sahara', '/platform/login']) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible(FIRST_RENDER)
    await expectScheme(page, 'dark')
    await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked()
  }

  // Another tab of the same browser follows a choice made here, without a reload.
  const other = await page.context().newPage()
  await other.goto('/c/sahara')
  await expect(other.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible(FIRST_RENDER)
  await expectScheme(other, 'dark')
  await page.getByText('Light', { exact: true }).click()
  await expectScheme(other, 'light')
  await expect(other.getByRole('radio', { name: 'Light' })).toBeChecked()
  await page.context().close()
})

test('System follows the device’s own scheme live; a choice holds whatever the device says', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The device’s scheme: once is enough')
  const page = await openWith(browser, testInfo.project.use, { colorScheme: 'light' })
  await mockCompanyApi(page, { company: SAHARA })
  await page.goto('/c/sahara')
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible(FIRST_RENDER)
  await expectScheme(page, 'light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expectScheme(page, 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expectScheme(page, 'light')

  await page.getByText('Dark', { exact: true }).click()
  await expectScheme(page, 'dark')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.emulateMedia({ colorScheme: 'light' })
  await expectScheme(page, 'dark')
  await page.getByText('Light', { exact: true }).click()
  await page.emulateMedia({ colorScheme: 'dark' })
  await expectScheme(page, 'light')
  await page.context().close()
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
  expect(await page.locator('[data-logo-plate]').evaluate((plate) => getComputedStyle(plate).backgroundColor)).toBe('rgb(255, 255, 255)')

  // Dark: the logo for dark surfaces, the plate lets go of its fill, the chrome takes the deep step.
  await page.getByText('Dark', { exact: true }).click()
  await expect.poll(() => shownLogo(page.locator('[data-identity-lockup="page"]'))).toBe('/api/v1/public/companies/sahara/brand/logo_dark.png')
  await expect.poll(() => themeColour(page)).toBe(palette.deep)
  expect(await page.locator('[data-logo-plate]').evaluate((plate) => getComputedStyle(plate).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
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

/* The account menus -------------------------------------------------------------------------------- */

async function openAccountMenu(page: Page, name: string) {
  const trigger = page.getByRole('button', { name: `Account menu for ${name}` })
  await trigger.focus()
  await page.keyboard.press('Enter')
  return { trigger, menu: page.getByRole('menu', { name: `Account menu for ${name}` }) }
}

test('the account menus offer the appearance as a group of three menuitemradio, by keyboard: Space keeps the menu open, Enter closes it', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === 'tablet', 'The phone and the desktop are enough here')
  const page = await openWith(browser, testInfo.project.use, { colorScheme: 'light' })
  await mockCompanyApi(page, { company: SAHARA, signedIn: 'en', platform: 'en', extra: (path, route) => (path === '/platform/companies' ? route.fulfill({ json: { items: [platformCompanyOf(SAHARA)], page: 1, page_size: 25, total: 1 } }) : undefined) })
  await page.goto('/visits')
  await expect(page.getByRole('heading', { level: 1, name: 'My visits' })).toBeVisible(FIRST_RENDER)

  const { trigger, menu } = await openAccountMenu(page, 'Lina Haddad')
  const group = menu.getByRole('group', { name: 'Appearance' })
  await expect(group.getByRole('menuitemradio')).toHaveText(['Light', 'Dark', 'System'])
  await expect(group.getByRole('menuitemradio', { name: 'System' })).toHaveAttribute('aria-checked', 'true')
  await expect(group.getByRole('menuitemradio', { name: 'Light' })).toBeFocused()
  // The popup stays inside the screen, the three choices on one row.
  const box = await menu.locator('..').boundingBox()
  const viewport = page.viewportSize()!
  expect(box && box.x >= 0 && box.x + box.width <= viewport.width).toBe(true)
  const tops = await group.getByRole('menuitemradio').evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)))
  expect(new Set(tops).size).toBe(1)
  await expectNoAxeViolations(page, 'the account menu, open')

  await page.keyboard.press('ArrowRight')
  await expect(group.getByRole('menuitemradio', { name: 'Dark' })).toBeFocused()
  await page.keyboard.press('Space')
  await expect(group.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true')
  await expect(menu).toBeVisible()
  await expectScheme(page, 'dark')
  await expectNoAxeViolations(page, 'the account menu, open, Dark')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Enter')
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()
  await expectScheme(page, 'light')

  // The platform owner's menu: the same choice, for the same device.
  await page.goto('/platform/companies')
  await expect(page.getByRole('heading', { level: 1, name: 'Companies' })).toBeVisible(FIRST_RENDER)
  const platform = await openAccountMenu(page, 'Platform Owner')
  const platformGroup = platform.menu.getByRole('group', { name: 'Appearance' })
  await expect(platformGroup.getByRole('menuitemradio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true')
  // The browser's chrome is the platform's own shell: the deep teal, the slate in the dark scheme.
  await expect.poll(() => themeColour(page)).toBe('#0f3b3f')
  await platformGroup.getByRole('menuitemradio', { name: 'Dark' }).click()
  await expectScheme(page, 'dark')
  await expect.poll(() => themeColour(page)).toBe('#33444e')
  // The platform's shell in the dark scheme is the slate, never a company's deep teal.
  const shell = page.locator('aside:visible, header[data-app-bar]:visible').first()
  await expect.poll(() => shell.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(51, 68, 78)')
  await expectNoAxeViolations(page, 'the platform’s companies, Dark, menu open')
  await page.context().close()
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

const paintOf = (element: Locator) => element.evaluate((node) => ({ background: getComputedStyle(node).backgroundColor, colour: getComputedStyle(node).color }))

/**
 * In a forced-colours mode every fill is the system's Canvas: a choice shown by its fill alone would
 * not show. The chosen one takes the system's selection colours: a fill unlike its neighbours', its
 * word on it (no backplate of the page's Canvas behind the word).
 */
async function expectChosenShows(page: Page, chosen: Locator, other: Locator, what: string) {
  const [mine, theirs] = [await paintOf(chosen), await paintOf(other)]
  expect(mine.background, `${what}: the chosen one's fill`).not.toBe(theirs.background)
  expect(mine.colour, `${what}: its word on its fill`).not.toBe(mine.background)
  // On screen: most of it is that fill, and its word is there in the other colour.
  const shot = await chosen.screenshot()
  expect(await shareOf(page, shot, mine.background), `${what}: the fill drawn`).toBeGreaterThan(0.5)
  expect(await shareOf(page, shot, mine.colour), `${what}: the word drawn`).toBeGreaterThan(0.02)
}

test('in a forced-colours mode (Windows’ contrast themes) the chosen appearance still shows, on a page and in the account menu', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Chromium’s forced colours: once is enough')
  const page = await openWith(browser, testInfo.project.use, { colorScheme: 'light', forcedColors: 'active', ...stored(testInfo.project.use, 'dark') })
  await mockCompanyApi(page, { company: SAHARA, signedIn: 'en' })
  // The switch beside the language switch (the pass's header: a page of its own, signed in or not).
  await page.goto(`/pass?c=sahara#${PASS_TOKEN}`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible(FIRST_RENDER)
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true)
  const segment = (name: string) => page.locator('[data-appearance-switch] label').filter({ hasText: name })
  await expectChosenShows(page, segment('Dark'), segment('Light'), 'the switch')
  await page.getByRole('radio', { name: 'Light' }).focus()
  await page.keyboard.press('Space')
  // The page's own canvas is the system's Canvas here: the scheme on the root says the choice was made.
  await expect.poll(() => schemeOf(page)).toBe('light')
  await expectChosenShows(page, segment('Light'), segment('Dark'), 'the switch, Light')

  // The account menu's tiles.
  await page.goto('/visits')
  await expect(page.getByRole('heading', { level: 1, name: 'My visits' })).toBeVisible(FIRST_RENDER)
  const { menu } = await openAccountMenu(page, 'Lina Haddad')
  const group = menu.getByRole('group', { name: 'Appearance' })
  await expectChosenShows(page, group.getByRole('menuitemradio', { name: 'Light' }), group.getByRole('menuitemradio', { name: 'System' }), 'the account menu')
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

test('the reception screen: dark under System as before, light for a device that chose Light, dark for Dark; its camera panel dark in all three', async ({ browser }, testInfo) => {
  // Three devices, each with four tabs under axe: more than the project's minute when the suite runs in parallel.
  test.setTimeout(180_000)
  for (const [appearance, device, expected] of [
    ['system', 'light', 'dark'],
    ['light', 'dark', 'light'],
    ['dark', 'light', 'dark'],
  ] as const) {
    const page = await openWith(browser, testInfo.project.use, { colorScheme: device, ...stored(testInfo.project.use, appearance) })
    await mockCompanyApi(page, receptionApi(SAHARA))
    await page.goto('/reception')
    await expect(page.getByText('Ready to scan')).toBeVisible(FIRST_RENDER)
    const label = `${appearance} on a ${device} device`
    await expect.poll(() => page.locator('[data-surface="dark"]').count(), label).toBe(expected === 'dark' ? 1 : 0)
    await expect.poll(() => canvasOf(page), label).toBe(CANVAS[expected])
    // The shell: the company's own (yellow) for Light, the deep one around the dark screen.
    const shell = page.locator('aside:visible, header[data-app-bar]:visible').first()
    const shellColour = await shell.evaluate((element) => getComputedStyle(element).backgroundColor)
    if (expected === 'light') expect(shellColour, label).toBe('rgb(245, 184, 0)')
    else expect(shellColour, label).not.toBe('rgb(245, 184, 0)')
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

import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test'
import type { Language } from '../src/i18n/languages.ts'
import { rgb } from './support/identity.ts'
import { mockPalette } from './support/mock-brand.ts'
import { COMPANY_ID, drawFile, gate, mockCompanyApi, publicBrandOf, readPng, rootToken, shellOf, type DrawnFile, type MockApiOptions, type MockCompany } from './support/mock-company.ts'

/*
 * The fixes of the Phase 12 UX review, in the browser (decisions F12-29 on). The API is mocked, so
 * this spec needs only the Vite server; the palettes are the server's own (`mockPalette`).
 *
 * - A company's own colour on its surfaces: a yellow company is yellow. The shell and the primary
 *   buttons are the palette's `surface`, and on a light one everything follows the dark ink: texts,
 *   the current page, hover fills, dividers, the focus ring; a near-white shell ends at a line.
 * - The account menu stays inside a phone's screen with a long company name.
 * - A logo with a background of its own stands on a plate on the signed-out pages; an emblem has the
 *   company's name beside it.
 * - The identity page refuses a logo that would not show where it is chosen for, a strip, a column
 *   and a picture too small; takes the white background of a JPEG away; makes the icon of a wordmark
 *   from the company's letter on its colour; offers no compression artefact as a colour.
 * - A slow first visit is drawn in nobody's colours, then in the company's without a fade; the
 *   password pages follow the device's company.
 */

const FIRST_RENDER = { timeout: 30_000 }
const LANGUAGES: Language[] = ['en', 'ar']
const INK = '#1c262b'
const PASS_TOKEN = 'rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2AXo3_vK9-aQ2'

const COMPANIES = {
  yellow: { slug: 'sahara', name: 'Sahara Sun Hotels', name_ar: 'فنادق شمس الصحراء', colour: '#f5b800' },
  pastel: { slug: 'lilac', name: 'Lilac Spa', name_ar: 'منتجع الليلك', colour: '#f9c6d0' },
  neon: { slug: 'volt', name: 'Volt Energy', name_ar: 'فولت للطاقة', colour: '#39ff14' },
  nearWhite: { slug: 'pearl', name: 'Pearl Studio', name_ar: 'استوديو اللؤلؤ', colour: '#fafafa' },
  navy: { slug: 'atlas', name: 'Atlas Bank', name_ar: 'بنك الأطلس', colour: '#0b1f4b' },
  midGrey: { slug: 'granite', name: 'Granite Works', name_ar: 'أعمال الغرانيت', colour: '#8a8a8a' },
  long: {
    slug: 'long-name',
    name: 'International Company for Advanced Technological Solutions and Integrated Digital Services',
    name_ar: 'الشركة الدولية للحلول التقنية المتقدمة والخدمات الرقمية المتكاملة',
    colour: '#f5b800',
  },
  plain: { slug: 'other-corp', name: 'Other Corp', name_ar: null, colour: null },
} satisfies Record<string, MockCompany>

/* Pictures, drawn where they are used (`drawFile`): the body of a function of the context `x`, the width `w` and the height `h`. */
const wordmarkPaint = (colour: string, background: string | null, text = '#3b2a12') =>
  `${background ? `x.fillStyle='${background}'; x.fillRect(0,0,w,h);` : 'x.clearRect(0,0,w,h);'}
   x.fillStyle='${colour}'; x.beginPath(); x.arc(120,120,96,0,Math.PI*2); x.fill();
   x.fillStyle='${text}'; x.font='bold 104px Arial'; x.textBaseline='middle'; x.fillText('SAHARA',250,126);`
const emblemPaint = (colour: string, glyph: string) =>
  `x.clearRect(0,0,w,h); x.fillStyle='${colour}'; x.beginPath(); x.roundRect(16,16,480,480,120); x.fill();
   x.fillStyle='${glyph}'; x.font='bold 300px Arial'; x.textAlign='center'; x.textBaseline='middle'; x.fillText('L',256,276);`
/** A navy and gold logo on white, as a JPEG saves it: the white is part of the file. */
const ATLAS_PAINT = `x.fillStyle='#ffffff'; x.fillRect(0,0,w,h);
   x.fillStyle='#0b1f4b'; x.beginPath(); x.moveTo(60,320); x.lineTo(190,80); x.lineTo(250,190); x.lineTo(290,130); x.lineTo(380,320); x.closePath(); x.fill();
   x.fillStyle='#c9a227'; x.fillRect(60,335,320,14);
   x.fillStyle='#0b1f4b'; x.font='bold 120px Georgia'; x.textBaseline='middle'; x.fillText('ATLAS',420,170);
   x.fillStyle='#c9a227'; x.font='bold 54px Georgia'; x.fillText('B A N K',426,280);`

/** A line of text in purple, vertically centred. */
const textPaint = (label: string, size: number) => `x.clearRect(0,0,w,h); x.fillStyle='#6d28d9'; x.font='bold ${size}px Arial'; x.textBaseline='middle'; x.fillText('${label}',20,h/2);`

async function openWith(browser: Browser, projectUse: BrowserContextOptions, options: BrowserContextOptions = {}): Promise<Page> {
  const context = await browser.newContext({ baseURL: projectUse.baseURL, locale: 'en-US', viewport: projectUse.viewport, hasTouch: projectUse.hasTouch, ...options })
  const page = await context.newPage()
  // A document to draw pictures in, before the app is opened.
  await page.goto('about:blank')
  return page
}

async function expectNoAxeViolations(page: Page, what: string) {
  const results = await new AxeBuilder({ page }).analyze()
  const blocking = results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
  expect(blocking.map((violation) => `${violation.id}: ${violation.nodes.map((node) => `${node.target.join(' ')} ${node.any[0]?.message ?? ''}`).join(', ')}`), `axe: ${what}`).toEqual([])
}

const noHorizontalScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024

/** WCAG relative luminance of `rgb(r, g, b)` or `#rrggbb`. */
function luminance(colour: string): number {
  const channels = colour.startsWith('#') ? [1, 3, 5].map((index) => Number.parseInt(colour.slice(index, index + 2), 16)) : (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
  const [r, g, b] = channels.map((value) => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

async function openApp(browser: Browser, projectUse: BrowserContextOptions, options: MockApiOptions, language: Language, context: BrowserContextOptions = {}): Promise<Page> {
  const page = await openWith(browser, projectUse, context)
  await mockCompanyApi(page, { signedIn: language, ...options })
  await page.goto('/visits')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible(FIRST_RENDER)
  return page
}

/* A company's own colour on its surfaces ------------------------------------------------------ */

for (const key of ['yellow', 'pastel', 'neon', 'nearWhite'] as const) {
  const company = COMPANIES[key]
  test(`a light colour is itself on the shell and the buttons, under dark ink: ${key} (${company.colour})`, async ({ browser }, testInfo) => {
    const palette = mockPalette(company.colour)
    // The contract: the colour itself as the surface, the dark ink on it.
    expect(palette.surface).toBe(company.colour)
    expect(palette.on_surface).toBe(INK)
    for (const language of LANGUAGES) {
      const page = await openApp(browser, testInfo.project.use, { company }, language, { colorScheme: 'light' })
      const shell = shellOf(page)
      const label = `${key} ${language}`

      // The shell is the colour; its texts and icons are the ink.
      expect(await shell.evaluate((element) => getComputedStyle(element).backgroundColor), label).toBe(rgb(company.colour))
      expect(await shell.evaluate((element) => getComputedStyle(element).color), label).toBe(rgb(INK))
      // Its scrollbars and the browser's own controls follow: a light surface.
      expect(await rootToken(page, '--brand-shell-scheme')).toBe('light')
      expect(await shell.evaluate((element) => getComputedStyle(element).colorScheme), label).toBe('light')
      await expect(page.locator('head meta[name="theme-color"]')).toHaveAttribute('content', company.colour)
      // The language switch on it: ink text, an outline that shows on the colour (3:1).
      const languageSwitch = shell.locator('[data-language-switch]')
      expect(await languageSwitch.evaluate((element) => getComputedStyle(element).color)).toBe(rgb(INK))
      const outline = await languageSwitch.evaluate((element) => getComputedStyle(element).borderTopColor)
      expect((Math.max(luminance(outline), luminance(company.colour)) + 0.05) / (Math.min(luminance(outline), luminance(company.colour)) + 0.05), `${label}: the switch's outline on the shell`).toBeGreaterThanOrEqual(3)

      // The primary button: the colour itself under its ink.
      const primary = page.locator('main a:visible, main button:visible').filter({ hasText: language === 'ar' ? 'دعوة زائر' : 'Invite visitor' }).first()
      await expect(primary).toBeVisible()
      expect(await primary.evaluate((element) => getComputedStyle(element).backgroundColor), label).toBe(rgb(company.colour))
      expect(await primary.evaluate((element) => getComputedStyle(element).color), label).toBe(rgb(INK))
      // A button that would blend into the page has an edge in its ink; a colour that stands off by itself has none.
      const edge = await primary.evaluate((element) => getComputedStyle(element).boxShadow)
      if (key === 'nearWhite') expect(edge, label).toContain('rgb(28, 38, 43)')
      else expect(edge, label).not.toContain('rgb(28, 38, 43)')
      // Links and coloured text on white keep a step that reads there.
      const linkColour = await rootToken(page, '--color-accent-text')
      expect((1.05 / (luminance(linkColour) + 0.05)), `${label}: link text on white`).toBeGreaterThanOrEqual(4.5)

      // The navigation: on a desktop in the sidebar, below in the drawer, which is the same colour.
      let navigation = shell
      if (!isDesktop(page)) {
        await shell.getByRole('button').first().click()
        navigation = page.getByRole('dialog')
        await expect(navigation).toBeVisible()
        expect(await navigation.evaluate((element) => getComputedStyle(element).backgroundColor), `${label}: the drawer`).toBe(rgb(company.colour))
        // The line under the drawer's head, and its close button: the ink, never white.
        expect(await navigation.locator('> div').first().evaluate((element) => getComputedStyle(element).borderBottomColor)).toBe('rgba(28, 38, 43, 0.22)')
        expect(await navigation.locator('button').first().evaluate((element) => getComputedStyle(element).color)).toBe(rgb(INK))
      }
      // The current page: an ink pill, its label the shell's colour.
      const current = navigation.locator('nav a[aria-current="page"]')
      expect(await current.evaluate((element) => getComputedStyle(element).backgroundColor), label).toBe(rgb(INK))
      expect(await current.evaluate((element) => getComputedStyle(element).color), label).toBe(rgb(company.colour))
      const other = navigation.locator('nav a:not([aria-current])').first()
      expect(await other.evaluate((element) => getComputedStyle(element).color), label).toBe(rgb(INK))

      if (isDesktop(page)) {
        // A pointer on an item: the ink laid thinly over the shell (a white overlay would not show on a light colour).
        await other.hover()
        await expect.poll(() => other.evaluate((element) => getComputedStyle(element).backgroundColor), label).toBe('rgba(28, 38, 43, 0.1)')
        // The user block: its line is the ink, its tile the ink with the shell's colour as its letters.
        const account = shell.locator('button[aria-haspopup="menu"]')
        expect(await account.evaluate((element) => getComputedStyle(element).borderTopColor)).toBe('rgba(28, 38, 43, 0.22)')
        expect(await account.locator('[data-avatar]').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(rgb(INK))
        expect(await account.locator('[data-avatar]').evaluate((element) => getComputedStyle(element).color)).toBe(rgb(company.colour))
        // The keyboard's ring on the shell: the ink (a white ring is invisible on a light colour).
        await page.mouse.move(700, 500)
        await other.focus()
        await page.keyboard.press('Tab')
        await page.keyboard.press('Shift+Tab')
        await expect.poll(() => other.evaluate((element) => (element.matches(':focus-visible') ? getComputedStyle(element).outlineColor : 'not focused')), label).toBe(rgb(INK))
        // The shell's own boundary: only where it would blend into the grey canvas.
        const boundary = await shell.evaluate((element) => getComputedStyle(element).borderInlineEndColor)
        if (key === 'nearWhite') expect(boundary, label).toBe('rgba(28, 38, 43, 0.16)')
        else expect(boundary, label).toBe('rgba(0, 0, 0, 0)')
      } else {
        const boundary = await shell.evaluate((element) => getComputedStyle(element).borderBottomColor)
        if (key === 'nearWhite') expect(boundary, label).toBe('rgba(28, 38, 43, 0.16)')
        else expect(boundary, label).toBe('rgba(0, 0, 0, 0)')
      }

      await noHorizontalScroll(page)
      await expectNoAxeViolations(page, label)
      await page.context().close()
    }

    // The dark colour scheme keeps the deep and bright steps: a dark shell under white, as before.
    const dark = await openApp(browser, testInfo.project.use, { company }, 'en', { colorScheme: 'dark' })
    expect(await shellOf(dark).evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(rgb(palette.deep))
    expect(await shellOf(dark).evaluate((element) => getComputedStyle(element).color)).toBe('rgb(255, 255, 255)')
    expect(await rootToken(dark, '--color-accent')).toBe(palette.bright)
    expect(await shellOf(dark).evaluate((element) => getComputedStyle(element).colorScheme)).toBe('dark')
    await expectNoAxeViolations(dark, `${key} dark`)
    await dark.context().close()
  })
}

test('a dark colour and a mid-tone are drawn under white: the colour itself, or its darkened step where neither ink reads', async ({ browser }, testInfo) => {
  for (const key of ['navy', 'midGrey'] as const) {
    const company = COMPANIES[key]
    const palette = mockPalette(company.colour)
    expect(palette.on_surface).toBe('#ffffff')
    expect(palette.surface).toBe(key === 'navy' ? company.colour : palette.strong)
    const page = await openApp(browser, testInfo.project.use, { company }, 'en', { colorScheme: 'light' })
    const shell = shellOf(page)
    expect(await shell.evaluate((element) => getComputedStyle(element).backgroundColor), key).toBe(rgb(palette.surface))
    expect(await shell.evaluate((element) => getComputedStyle(element).color), key).toBe('rgb(255, 255, 255)')
    expect(await rootToken(page, '--color-accent')).toBe(palette.surface)
    expect(await rootToken(page, '--color-on-accent')).toBe('#ffffff')
    expect(await shell.evaluate((element) => getComputedStyle(element).colorScheme)).toBe('dark')
    await expectNoAxeViolations(page, key)
    await page.context().close()
  }
})

test('a light shell carries the logo for light surfaces on its plate, never the one for dark surfaces; the deep shell carries that one', async ({ browser }, testInfo) => {
  const company = COMPANIES.yellow
  const draft = await openWith(browser, testInfo.project.use)
  const logo = (await drawFile(draft, 'logo.png', 900, 240, wordmarkPaint(company.colour, null))).buffer
  const logoDark = (await drawFile(draft, 'logo-dark.png', 900, 240, wordmarkPaint('#ffffff', null, '#ffffff'))).buffer
  await draft.context().close()

  for (const scheme of ['light', 'dark'] as const) {
    const page = await openApp(browser, testInfo.project.use, { company, files: { logo, logo_dark: logoDark } }, 'en', { colorScheme: scheme })
    const image = shellOf(page).locator('[data-identity-lockup="shell"] img')
    await expect(image).toBeVisible()
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => (element.complete && element.naturalWidth > 0 ? new URL(element.currentSrc).pathname : ''))).toContain(scheme === 'light' ? '/brand/logo.png' : '/brand/logo_dark.png')
    const plate = shellOf(page).locator('[data-logo-plate]')
    expect(await plate.evaluate((element) => getComputedStyle(element).backgroundColor), scheme).toBe(scheme === 'light' ? 'rgb(255, 255, 255)' : 'rgba(0, 0, 0, 0)')
    await expectNoAxeViolations(page, `the logo on the ${scheme} shell`)
    await page.context().close()
  }
})

/* The account menu ---------------------------------------------------------------------------- */

test('the account menu stays inside the screen with a long company name, and its items in reach', async ({ browser }, testInfo) => {
  for (const language of LANGUAGES) {
    const page = await openApp(browser, testInfo.project.use, { company: COMPANIES.long }, language)
    await shellOf(page).locator('button[aria-haspopup="menu"]').click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    const measured = await menu.evaluate((element) => {
      const popup = element.parentElement!.getBoundingClientRect()
      const company = document.querySelector('[data-user-company] span')!
      return {
        viewport: document.documentElement.clientWidth,
        left: popup.left,
        right: popup.right,
        width: popup.width,
        items: [...element.querySelectorAll('[role="menuitem"]')].map((item) => {
          const box = item.getBoundingClientRect()
          // What a tap in the middle of the item lands on.
          return { left: box.left, right: box.right, height: box.height, reached: item.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)) }
        }),
        companyLines: Math.round(company.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(company).lineHeight)),
        companyClipped: company.scrollWidth > company.clientWidth + 1,
      }
    })
    const label = `${language} at ${measured.viewport} px`
    // Never wider than 20rem, nor than the screen less its gutters; wholly on the screen.
    expect(measured.width, label).toBeLessThanOrEqual(Math.min(320, measured.viewport - 24) + 0.5)
    expect(measured.left, label).toBeGreaterThanOrEqual(0)
    expect(measured.right, label).toBeLessThanOrEqual(measured.viewport)
    expect(measured.items, label).toHaveLength(2)
    for (const item of measured.items) {
      expect(item.left, label).toBeGreaterThanOrEqual(0)
      expect(item.right, label).toBeLessThanOrEqual(measured.viewport)
      expect(item.reached, `${label}: a tap reaches the item`).toBe(true)
    }
    // The company's name wraps onto a second line and is cut there: it does not widen the menu.
    expect(measured.companyLines, label).toBe(2)
    expect(measured.companyClipped, label).toBe(false)
    await expect(page.getByRole('menuitem', { name: language === 'ar' ? 'تسجيل الخروج' : 'Sign out' })).toBeInViewport({ ratio: 1 })
    await noHorizontalScroll(page)
    await expectNoAxeViolations(page, `the account menu, ${label}`)
    // The width is the popup's own, whatever a line in it does: with the name kept on one line (as it was
    // when the menu was 598 px wide on a phone) the popup is as narrow, and its items are still on the screen.
    const unwrapped = await menu.evaluate((element) => {
      const company = document.querySelector<HTMLElement>('[data-user-company] span')!
      company.style.display = 'block'
      company.style.whiteSpace = 'nowrap'
      const popup = element.parentElement!.getBoundingClientRect()
      return { width: popup.width, left: popup.left, right: popup.right, line: company.scrollWidth }
    })
    expect(unwrapped.line, `${label}: the name on one line is longer than the popup`).toBeGreaterThan(320)
    expect(unwrapped.width, `${label}: the popup with a line that cannot wrap`).toBeLessThanOrEqual(Math.min(320, measured.viewport - 24) + 0.5)
    expect(unwrapped.left, label).toBeGreaterThanOrEqual(0)
    expect(unwrapped.right, label).toBeLessThanOrEqual(measured.viewport)
    await page.context().close()
  }
})

/* Logos on the signed-out pages --------------------------------------------------------------- */

test('a logo with a background of its own stands on a plate on the signed-out pages, in both schemes', async ({ browser }, testInfo) => {
  const company = COMPANIES.navy
  const draft = await openWith(browser, testInfo.project.use)
  // Saved before the page took backgrounds away: an opaque white rectangle around the drawing.
  const logo = (await drawFile(draft, 'atlas.png', 1000, 400, ATLAS_PAINT)).buffer
  await draft.context().close()

  for (const scheme of ['light', 'dark'] as const) {
    for (const [what, address, heading] of [
      ['sign in', `/c/${company.slug}`, 'Sign in'],
      ['forgot password', `/forgot-password?c=${company.slug}`, 'Reset your password'],
      ['the visitor’s pass', `/pass?c=${company.slug}#${PASS_TOKEN}`, 'Visitor pass'],
      ['a page that is not there', `/no-such-page?c=${company.slug}`, 'Page not found'],
    ] as const) {
      const page = await openWith(browser, testInfo.project.use, { colorScheme: scheme })
      await mockCompanyApi(page, { company, files: { logo } })
      await page.goto(address)
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible(FIRST_RENDER)
      const image = page.locator('[data-identity-lockup="page"] img')
      await expect(image).toBeVisible()
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
      const plate = page.locator('[data-identity-lockup="page"] [data-logo-plate]')
      const label = `${what}, ${scheme}`
      // White, with an edge, and room around the picture: a white rectangle on it is no longer a rectangle on the page.
      expect(await plate.evaluate((element) => getComputedStyle(element).backgroundColor), label).toBe('rgb(255, 255, 255)')
      expect(await plate.evaluate((element) => getComputedStyle(element).borderTopWidth), label).toBe('1px')
      const [plateBox, imageBox] = [await plate.boundingBox(), await image.boundingBox()]
      expect(imageBox!.x - plateBox!.x, label).toBeGreaterThanOrEqual(8)
      expect(plateBox!.x + plateBox!.width - (imageBox!.x + imageBox!.width), label).toBeGreaterThanOrEqual(8)
      expect(imageBox!.y - plateBox!.y, label).toBeGreaterThanOrEqual(6)
      expect(Number.parseFloat(await plate.evaluate((element) => getComputedStyle(element).borderTopLeftRadius)), label).toBeGreaterThanOrEqual(8)
      await noHorizontalScroll(page)
      await expectNoAxeViolations(page, label)
      await page.context().close()
    }
  }
})

test('an emblem has the company’s name written beside it: the shell, the sign-in page and the pass', async ({ browser }, testInfo) => {
  const company = COMPANIES.pastel
  const draft = await openWith(browser, testInfo.project.use)
  const logo = (await drawFile(draft, 'emblem.png', 512, 512, emblemPaint(company.colour, INK))).buffer
  await draft.context().close()

  for (const language of LANGUAGES) {
    const name = language === 'ar' ? company.name_ar : company.name
    const page = await openApp(browser, testInfo.project.use, { company, files: { logo } }, language)
    const shell = shellOf(page)
    const lockup = shell.locator('[data-identity-lockup="shell"]')
    await expect(lockup.locator('[data-company-name]')).toHaveText(name)
    // The name is read once: the picture beside it has no text alternative.
    await expect(lockup.locator('img')).toHaveAttribute('alt', '')
    // The lockup keeps to its place: inside the shell, and clear of the controls beside it.
    const [lockupBox, shellBox] = [await lockup.boundingBox(), await shell.boundingBox()]
    expect(lockupBox!.x).toBeGreaterThanOrEqual(shellBox!.x)
    expect(lockupBox!.x + lockupBox!.width).toBeLessThanOrEqual(shellBox!.x + shellBox!.width + 0.5)
    const overlaps = await shell.evaluate((element) => {
      const box = element.querySelector('[data-identity-lockup="shell"]')!.getBoundingClientRect()
      const head = [...element.querySelectorAll('[data-language-switch], button[aria-expanded], button[aria-haspopup="menu"]')].filter((control) => control.getBoundingClientRect().top < box.bottom)
      return head.filter((control) => {
        const other = control.getBoundingClientRect()
        return other.left < box.right && box.left < other.right && other.top < box.bottom && box.top < other.bottom
      }).length
    })
    expect(overlaps, `${language}: controls under the lockup`).toBe(0)
    await noHorizontalScroll(page)
    await expectNoAxeViolations(page, `the emblem on the shell, ${language}`)
    await page.context().close()

    for (const [address, heading] of [
      [`/c/${company.slug}`, language === 'ar' ? 'تسجيل الدخول' : 'Sign in'],
      [`/pass?c=${company.slug}#${PASS_TOKEN}`, language === 'ar' ? 'بطاقة الزيارة' : 'Visitor pass'],
    ] as const) {
      const signedOut = await openWith(browser, testInfo.project.use, { locale: language === 'ar' ? 'ar-JO' : 'en-US' })
      await mockCompanyApi(signedOut, { company, files: { logo } })
      await signedOut.goto(address)
      await expect(signedOut.getByRole('heading', { level: 1, name: heading })).toBeVisible(FIRST_RENDER)
      const pageLockup = signedOut.locator('[data-identity-lockup="page"]')
      await expect(pageLockup.locator('[data-company-name]')).toHaveText(name)
      // Beside it, not under it: the two share a line.
      const [imageBox, nameBox] = [await pageLockup.locator('img').boundingBox(), await pageLockup.locator('[data-company-name]').boundingBox()]
      expect(Math.abs(imageBox!.y + imageBox!.height / 2 - (nameBox!.y + nameBox!.height / 2))).toBeLessThanOrEqual(6)
      await noHorizontalScroll(signedOut)
      await expectNoAxeViolations(signedOut, `the emblem on ${address}, ${language}`)
      await signedOut.context().close()
    }
  }
})

/* The identity page: what a picture is like --------------------------------------------------- */

async function openIdentityPage(browser: Browser, projectUse: BrowserContextOptions, company: MockCompany, sent?: MockApiOptions['sent'], language: Language = 'en'): Promise<Page> {
  const page = await openWith(browser, projectUse)
  await mockCompanyApi(page, { company, platform: language, sent })
  await page.goto(`/platform/companies/${COMPANY_ID}/identity`)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible(FIRST_RENDER)
  return page
}

const slot = (page: Page, kind: string) => page.locator(`[data-asset-slot="${kind}"]`)
const choose = (page: Page, kind: string, file: DrawnFile) => page.locator(`[data-asset-input="${kind}"]`).setInputFiles(file)
const staged = (page: Page, kind: string) => slot(page, kind).locator('[data-asset-preview] img')

test('the identity page refuses a logo that would not show where it is chosen for, and says where it belongs', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === 'tablet', 'The desktop and the phone cover both layouts')
  const page = await openIdentityPage(browser, testInfo.project.use, COMPANIES.plain)
  const white = await drawFile(page, 'sahara-white.png', 900, 240, wordmarkPaint('#ffffff', null, '#ffffff'))
  const black = await drawFile(page, 'noir.png', 800, 200, "x.clearRect(0,0,w,h); x.fillStyle='#000000'; x.font='bold 130px Arial'; x.textBaseline='middle'; x.fillText('NOIR & CO',10,105);")

  // A white logo in the place for white backgrounds (the UX review: accepted without a word, a white box everywhere).
  await choose(page, 'logo', white)
  await expect(slot(page, 'logo')).toContainText('This logo is too light to show on a white background. Choose a dark version here, and use this one as the “Logo for dark surfaces”.')
  await expect(staged(page, 'logo')).toHaveCount(0)
  await expect(staged(page, 'icon')).toHaveCount(0)
  await expect(page.locator('[data-suggested-colour]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save identity' })).toHaveAttribute('aria-disabled', 'true')
  // Where it belongs, it is taken.
  await choose(page, 'logo_dark', white)
  await expect(staged(page, 'logo_dark')).toBeVisible()
  await expect(slot(page, 'logo_dark')).not.toContainText('too')

  // The mirror: a black logo in the place for dark surfaces; it is a logo for white ones.
  await choose(page, 'logo_dark', black)
  await expect(slot(page, 'logo_dark')).toContainText('This logo is too dark to show on a dark background. Choose a light version here, and use this one as the “Logo”.')
  await choose(page, 'logo', black)
  await expect(staged(page, 'logo')).toBeVisible()
  await expect(slot(page, 'logo')).not.toContainText('too')
  // A white picture as the icon would be a blank tile.
  await choose(page, 'icon', white)
  await expect(slot(page, 'icon')).toContainText('This image is too light to show on a white background. Choose a darker one.')

  await noHorizontalScroll(page)
  await expectNoAxeViolations(page, 'the identity page with refusals')
})

test('the identity page refuses a strip, a column and a picture too small to show sharply', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'The picture’s own rules: once is enough')
  const page = await openIdentityPage(browser, testInfo.project.use, COMPANIES.plain)
  // 27:1, as in the review: it was 136 × 5 px in the sidebar.
  await choose(page, 'logo', await drawFile(page, 'strip.png', 2400, 160, textPaint('INTERCONTINENTAL FREIGHT & CARGO', 120)))
  await expect(slot(page, 'logo')).toContainText('This logo is too wide. Choose one that is at most 8 times as wide as it is tall.')
  await choose(page, 'logo', await drawFile(page, 'column.png', 220, 900, "x.clearRect(0,0,w,h); x.fillStyle='#0e7490'; x.fillRect(60,20,100,860);"))
  await expect(slot(page, 'logo')).toContainText('This logo is too tall. Choose one that is at most twice as tall as it is wide.')
  await choose(page, 'logo', await drawFile(page, 'tiny.png', 40, 40, "x.clearRect(0,0,w,h); x.fillStyle='#db2777'; x.beginPath(); x.arc(20,20,18,0,Math.PI*2); x.fill();"))
  await expect(slot(page, 'logo')).toContainText('This image is too small. Choose one that is at least 96 pixels on its longer side.')
  await expect(staged(page, 'logo')).toHaveCount(0)
  // Eight to one is still a logo.
  await choose(page, 'logo', await drawFile(page, 'wide.png', 800, 100, "x.clearRect(0,0,w,h); x.fillStyle='#6d28d9'; x.fillRect(0,0,w,h);"))
  await expect(staged(page, 'logo')).toBeVisible()
  await expect(slot(page, 'logo')).toContainText('800 × 100 px')
})

test('the identity page takes a JPEG’s white background away, offers the logo’s own colours, and makes a wordmark’s icon from the company’s letter', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === 'tablet', 'The desktop and the phone cover both layouts')
  const company = { ...COMPANIES.plain, slug: 'atlas-bank', name: 'Atlas Bank', name_ar: 'بنك الأطلس' }
  const sent: NonNullable<MockApiOptions['sent']> = []
  const page = await openIdentityPage(browser, testInfo.project.use, company, sent)
  await choose(page, 'logo', await drawFile(page, 'atlas.jpg', 1000, 400, ATLAS_PAINT, 'image/jpeg'))
  await expect(staged(page, 'logo')).toBeVisible()
  // The drawing alone: the white around it is gone, and with it the room it took.
  const size = /(\d+) × (\d+) px/.exec((await slot(page, 'logo').textContent()) ?? '')
  expect(Number(size?.[1])).toBeLessThan(900)
  expect(Number(size?.[2])).toBeLessThan(320)

  // The logo's colours: its navy and its gold. Not the pale halo a JPEG leaves around the gold (#ffffd2 in the review).
  const colours = await page.locator('[data-suggested-colour]').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('data-suggested-colour')!))
  expect(colours).toHaveLength(2)
  expect(luminance(colours[0]!)).toBeLessThan(0.03)
  for (const colour of colours) expect(1.05 / (luminance(colour) + 0.05), `${colour} on white`).toBeGreaterThan(1.6)

  // A wordmark is a speck on a 16 px tile: the icon is the company's letter, on the neutral tile until it has a colour.
  await expect(staged(page, 'icon')).toBeVisible()
  await expect(slot(page, 'icon')).toContainText('Made from the name')
  await expect(slot(page, 'icon').getByRole('button', { name: 'Replace: App icon' })).toBeVisible()
  // The gold as the company's colour: the tile is drawn again in it, under its ink.
  const gold = colours[1]!
  await page.locator(`[data-suggested-colour="${gold}"]`).click()
  await expect(page.getByRole('button', { name: 'Save identity' })).not.toHaveAttribute('aria-disabled', 'true')
  await noHorizontalScroll(page)
  await expectNoAxeViolations(page, 'the identity page with a JPEG staged')
  await page.getByRole('button', { name: 'Save identity' }).click()
  await expect(page.getByText('Identity saved')).toBeVisible()

  const base = `/platform/companies/${COMPANY_ID}/brand`
  expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([`PUT ${base}/assets/logo`, `PUT ${base}/assets/icon`, `PATCH ${base}`])
  // The logo that was sent: transparent where the JPEG was white, the drawing as it was.
  const logo = await readPng(page, sent[0]!.body!, [[0.01, 0.02], [0.99, 0.02], [0.2, 0.75], [0.6, 0.02]])
  expect(logo.width).toBeLessThan(900)
  expect(logo.pixels[0]![3], 'the top corner at the start').toBe(0)
  expect(logo.pixels[1]![3], 'the top corner at the end').toBe(0)
  expect(logo.pixels[3]![3], 'above the mountain').toBe(0)
  // Inside the mountain: the navy, opaque.
  expect(logo.pixels[2]![3]).toBe(255)
  expect(logo.pixels[2]![2]).toBeGreaterThan(logo.pixels[2]![0]! + 30)
  // The icon that was sent: a 512 px tile of the colour's surface, with the letter in its ink.
  const palette = mockPalette(gold)
  const icon = await readPng(page, sent[1]!.body!, [[0.02, 0.02], [0.98, 0.98], [0.5, 0.02]])
  expect([icon.width, icon.height]).toEqual([512, 512])
  for (const corner of icon.pixels) expect(`rgb(${corner.slice(0, 3).join(', ')})`).toBe(rgb(palette.surface))
  const inked = await page.evaluate(
    async ([base64, ink]) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob())
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 512
      const context = canvas.getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      const data = context.getImageData(128, 128, 256, 256).data
      let count = 0
      for (let offset = 0; offset < data.length; offset += 4) if (Math.abs(data[offset]! - ink[0]!) + Math.abs(data[offset + 1]! - ink[1]!) + Math.abs(data[offset + 2]! - ink[2]!) < 24) count += 1
      return count / (256 * 256)
    },
    [sent[1]!.body!.toString('base64'), [1, 3, 5].map((index) => Number.parseInt(palette.on_surface.slice(index, index + 2), 16))] as const,
  )
  // The letter «A» fills a good part of the tile's middle.
  expect(inked).toBeGreaterThan(0.08)
  expect(JSON.parse(sent[2]!.body!.toString('utf8'))).toEqual({ color: gold })
})

/* A slow first visit, and the device's company ------------------------------------------------ */

test('a slow first visit is drawn in nobody’s colours, then in the company’s at once: never the default teal, never a fade', async ({ browser }, testInfo) => {
  const company = COMPANIES.yellow
  const page = await openWith(browser, testInfo.project.use)
  const { held, release } = gate()
  await mockCompanyApi(page, { company, hold: { path: `/public/companies/${company.slug}/brand`, release: held } })
  // Every colour the sign-in button has, frame by frame, from its first frame on.
  await page.addInitScript(() => {
    const seen = window as unknown as { buttonColours: string[] }
    seen.buttonColours = []
    const sample = () => {
      const button = document.querySelector('main button[type="submit"]')
      if (button) {
        const colour = getComputedStyle(button).backgroundColor
        if (seen.buttonColours.at(-1) !== colour) seen.buttonColours.push(colour)
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await page.goto(`/c/${company.slug}`)
  const button = page.getByRole('button', { name: 'Sign in' })
  await expect(button).toBeVisible(FIRST_RENDER)

  // The identity is not known yet: the button and the link are the neutral slate.
  expect(await button.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(51, 68, 78)')
  expect(await page.getByRole('link', { name: 'Forgot your password?' }).evaluate((element) => getComputedStyle(element).color)).toBe('rgb(51, 68, 78)')
  expect(await rootToken(page, '--color-accent')).toBe('#33444e')
  await expectNoAxeViolations(page, 'the sign-in page while its identity is on its way')

  release()
  await expect(page.locator('[data-identity-lockup="page"]')).toBeVisible()
  await expect.poll(() => button.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(rgb(company.colour))
  await page.waitForTimeout(400)
  // Two colours in all: the slate, then the company's. No teal before, nothing between.
  expect(await page.evaluate(() => (window as unknown as { buttonColours: string[] }).buttonColours)).toEqual(['rgb(51, 68, 78)', rgb(company.colour)])
})

test('the password pages follow the device’s company, as the sign-in page does', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name === 'tablet', 'The desktop and the phone cover both layouts')
  const company = COMPANIES.navy
  const palette = mockPalette(company.colour)
  for (const [address, heading] of [
    ['/forgot-password', 'Reset your password'],
    [`/reset-password#token=${PASS_TOKEN}`, 'Choose a new password'],
  ] as const) {
    const page = await openWith(browser, testInfo.project.use)
    // What an earlier sign-in left on the device.
    await page.addInitScript(
      ([slug, brands]) => {
        window.localStorage.setItem('vms.company', slug!)
        window.localStorage.setItem('vms.brands', brands!)
      },
      [company.slug, JSON.stringify([{ at: 1, brand: publicBrandOf(company) }])],
    )
    await mockCompanyApi(page, { company })
    await page.goto(address)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible(FIRST_RENDER)
    await expect(page).toHaveURL(new RegExp(`${address.split('#')[0]!.replace('/', '\\/')}\\?c=${company.slug}$`))
    await expect(page.locator('[data-identity-lockup="page"] [data-company-wordmark]')).toHaveText(company.name)
    await expect(page).toHaveTitle(`${heading} · ${company.name}`)
    expect(await rootToken(page, '--color-accent')).toBe(palette.surface)
    // A reset link's token is in no address the page has had since it rendered.
    expect(page.url()).not.toContain(PASS_TOKEN)
    await page.context().close()
  }
})

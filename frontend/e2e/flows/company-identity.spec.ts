import type { Page } from '@playwright/test'
import type { CompanyBrand, Me } from '../../src/types/api.ts'
import { ACCOUNTS } from '../support/accounts.ts'
import { Api, passToken } from '../support/api.ts'
import { expect, test } from '../support/fixtures.ts'
import { createCompany, imageLoaded, LOGO_COLOUR, LOGO_DARK_SVG, LOGO_PNG, NOT_AN_IMAGE, productTraces, rgb, rootToken, shellBackground } from '../support/identity.ts'
import { brandLogoDarkImage, brandLogoImage, pngFacts, waitForMessage } from '../support/outbox.ts'
import { BASE_URL } from '../support/paths.ts'
import { minutes } from '../support/time.ts'
import { changeTemporaryPassword, uniqueTag } from '../support/ui.ts'

/*
 * A company's identity (Phase 12), through the UI from end to end, in a company of the spec's own:
 * - the platform owner opens the company's identity page, chooses a logo (a PNG with empty room
 *   around it: the browser cuts it, fits it and makes the square icon), a logo for dark surfaces as
 *   an SVG (the browser rasterises it), takes a colour the page found in the logo, sees the preview
 *   and saves;
 * - the company's sign-in link shows that identity to someone who is not signed in;
 * - its administrator signs in there: the shell is in the company's colour with its logo, every
 *   title names the company, and a sign-out leads back to the company's own sign-in page;
 * - an invitation carries the company's logo and colour and never the product's name, and its pass
 *   link names the company;
 * - the visitor's pass page is in the company's identity, asks the server for the public brand
 *   alone and never sends the token.
 * Beside it: the general sign-in page is nobody's, a company without an identity is its own name in
 * the default colours, and the seeded company keeps the identity its seed gave it.
 */

/** A PNG read in the page: its top-left pixel, and how many of its pixels are close to `colour`. */
function pngPixels(page: Page, png: Buffer, colour: string): Promise<{ corner: number[]; near: number }> {
  return page.evaluate(
    async ([base64, hex]) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob())
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data
      const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)) as [number, number, number]
      let near = 0
      for (let index = 0; index < data.length; index += 4) {
        if (Math.abs(data[index]! - r) + Math.abs(data[index + 1]! - g) + Math.abs(data[index + 2]! - b) < 60) near += 1
      }
      return { corner: Array.from(data.slice(0, 3)), near }
    },
    [png.toString('base64'), colour] as const,
  )
}

test('company identity: set by the platform owner, seen by the company’s people and its visitors', async ({ open }) => {
  const tag = uniqueTag()
  const platform = await Api.platform()
  const { company, admin } = await createCompany(platform, tag)
  const slug = company.slug
  const signInLink = `${BASE_URL}/c/${slug}`

  // The platform owner, on the company's page: its identity is empty, and the way to it is there.
  const owner = await open({ platform: true, device: 'desktop' })
  await owner.page.goto(`/platform/companies/${company.id}`)
  await expect(owner.page.getByRole('heading', { level: 1, name: company.name })).toBeVisible()
  const card = owner.page.locator('section').filter({ has: owner.page.getByRole('heading', { level: 2, name: 'Identity' }) })
  await expect(card).toContainText('No logo')
  await expect(card).toContainText('Default colour')
  await expect(card.locator('[data-sign-in-link]')).toHaveText(signInLink)
  await card.getByRole('link', { name: 'Edit identity' }).click()
  await expect(owner.page.getByRole('heading', { level: 1, name: 'Identity' })).toBeVisible()
  // Whose identity it is: the company's name heads the page and is in the tab's title.
  await expect(owner.page.locator('[data-page-subject]')).toHaveText(company.name)
  await expect(owner.page).toHaveTitle(`Identity · ${company.name} · Mawdoo3 Visitors`)

  // A file that is no picture is refused on this device, with a clear message, and nothing is sent.
  const slot = (kind: string) => owner.page.locator(`[data-asset-slot="${kind}"]`)
  // Every request that changes a company's brand (the palette preview saves nothing and is not one).
  const uploads: string[] = []
  owner.page.on('request', (request) => {
    const requested = new URL(request.url()).pathname.replace('/api/v1', '')
    if (request.method() !== 'GET' && /^\/platform\/companies\/[^/]+\/brand(\/|$)/.test(requested)) uploads.push(`${request.method()} ${requested}`)
  })
  await owner.page.locator('[data-asset-input="logo"]').setInputFiles(NOT_AN_IMAGE)
  await expect(slot('logo')).toContainText('This file cannot be read as an image.')
  await expect(slot('logo').locator('[data-asset-preview] img')).toHaveCount(0)

  // The logo: decoded by the browser, the empty room around the drawing cut away, shown from the prepared PNG.
  await owner.page.locator('[data-asset-input="logo"]').setInputFiles(LOGO_PNG)
  const staged = slot('logo').locator('[data-asset-preview] img')
  await expect(staged).toBeVisible()
  await expect(staged).toHaveAttribute('src', /^blob:/)
  await expect(slot('logo')).toContainText('Not saved yet')
  await expect(slot('logo')).not.toContainText('This file cannot be read as an image.')
  // The fixture is 760 × 300 px with room around its drawing: what is staged is smaller than the file.
  const size = /(\d+) × (\d+) px/.exec((await slot('logo').textContent()) ?? '')
  expect(Number(size?.[1])).toBeLessThan(760)
  expect(Number(size?.[2])).toBeLessThan(300)
  // The square icon follows it. The logo is a wordmark (wider than a square can show), so the icon is the
  // company's letter on its colour: on the neutral tile until a colour is chosen.
  await expect(slot('icon').locator('[data-asset-preview] img')).toBeVisible()
  await expect(slot('icon')).toContainText('512 × 512 px')
  await expect(slot('icon')).toContainText('Made from the name')

  // The logo for dark surfaces, from an SVG.
  await owner.page.locator('[data-asset-input="logo_dark"]').setInputFiles(LOGO_DARK_SVG)
  await expect(slot('logo_dark').locator('[data-asset-preview] img')).toHaveAttribute('src', /^blob:/)
  expect(uploads, 'nothing is sent before Save').toEqual([])

  // The colour: found in the logo's own pixels, one tap away; the preview draws the palette the server derives.
  const suggestions = owner.page.getByRole('group', { name: 'Colours from the logo' })
  await expect(suggestions.getByRole('button').first()).toHaveText(LOGO_COLOUR)
  const palette = owner.page.waitForResponse((response) => response.url().endsWith('/api/v1/platform/brand/palette') && response.request().method() === 'POST')
  await suggestions.getByRole('button', { name: LOGO_COLOUR }).click()
  await expect(owner.page.getByRole('textbox', { name: 'Colour', exact: true })).toHaveValue(LOGO_COLOUR)
  expect((await palette).status()).toBe(200)
  const previewed = (await (await palette).json()) as NonNullable<CompanyBrand['palette']>
  // The logo's orange is a light colour: the company's surfaces are that orange itself, under dark ink.
  expect(previewed.surface).toBe(LOGO_COLOUR)
  expect(previewed.on_surface).toBe(previewed.on_bright)
  await expect.poll(() => owner.page.locator('[data-preview-shell]').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(rgb(previewed.surface))
  // The icon's tile is drawn again in the colour before the identity can be saved.
  await expect(owner.page.getByRole('button', { name: 'Save identity' })).not.toHaveAttribute('aria-disabled', 'true')
  await expect(owner.page.getByRole('img', { name: `Preview of the identity of ${company.name}` })).toBeVisible()
  // The platform's own page keeps the product's colours.
  expect(await rootToken(owner.page, '--color-accent')).toBe('#188086')

  await owner.page.getByRole('button', { name: 'Save identity' }).click()
  await expect(owner.page.getByText('Identity saved')).toBeVisible()
  await expect(owner.page.locator('[data-identity-status]')).toHaveText('All changes are saved.')
  // A file per request, PNG only; then the colour.
  const brandPath = `/platform/companies/${company.id}/brand`
  expect(uploads).toEqual([`PUT ${brandPath}/assets/logo`, `PUT ${brandPath}/assets/icon`, `PUT ${brandPath}/assets/logo_dark`, `PATCH ${brandPath}`])
  await expect(slot('logo').locator('[data-asset-preview] img')).toHaveAttribute('src', new RegExp(`^/api/v1/public/companies/${slug}/brand/logo\\.png\\?v=`))

  const brand = await platform.ok<CompanyBrand>('GET', brandPath)
  expect(brand.color).toBe(LOGO_COLOUR)
  expect(brand.palette).toEqual(previewed)
  expect(brand.logo_url).toMatch(new RegExp(`^/api/v1/public/companies/${slug}/brand/logo\\.png\\?v=`))
  expect(brand.logo_dark_url).toBeTruthy()
  expect(brand.icon_url).toBeTruthy()
  const { strong, surface, on_surface: ink } = brand.palette!

  // The company's page shows it now, and so does the companies list.
  await owner.page.getByRole('link', { name: company.name }).click()
  await expect(owner.page.getByRole('heading', { level: 1, name: company.name })).toBeVisible()
  await expect(card.getByRole('img', { name: `Logo of ${company.name}` })).toBeVisible()
  await expect(card).toContainText(LOGO_COLOUR)
  await expect.poll(() => imageLoaded(owner.page, '[data-company-logo-tile] img')).toBe(true)

  // The sign-in link, opened by someone who is not signed in.
  const admins = await open({ device: 'desktop' })
  await admins.page.goto(signInLink)
  await expect(admins.page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
  await expect(admins.page.getByRole('img', { name: company.name })).toBeVisible()
  await expect(admins.page).toHaveTitle(`Sign in · ${company.name}`)
  await expect.poll(() => imageLoaded(admins.page, '[data-identity-lockup="page"] img')).toBe(true)
  // The primary button is the company's own colour, under its ink; links on white are the step that reads there.
  expect(await rootToken(admins.page, '--color-accent')).toBe(surface)
  await expect.poll(() => admins.page.getByRole('button', { name: 'Sign in' }).evaluate((button) => getComputedStyle(button).backgroundColor)).toBe(rgb(surface))
  expect(await admins.page.getByRole('button', { name: 'Sign in' }).evaluate((button) => getComputedStyle(button).color)).toBe(rgb(ink))
  await expect(admins.page.locator('head link[rel="icon"]')).toHaveAttribute('href', brand.icon_url!)
  await expect(admins.page.locator('head link[rel="manifest"]')).toHaveAttribute('href', `/api/v1/public/companies/${slug}/manifest.webmanifest`)
  expect(await productTraces(admins.page)).toEqual([])
  // The other signed-out pages keep the company.
  await admins.page.getByRole('link', { name: 'Forgot your password?' }).click()
  await expect(admins.page).toHaveURL(`${BASE_URL}/forgot-password?c=${slug}`)
  await expect(admins.page.getByRole('img', { name: company.name })).toBeVisible()
  await admins.page.getByRole('link', { name: 'Back to sign in' }).click()
  await expect(admins.page).toHaveURL(signInLink)

  // The company's administrator signs in there: the shell is the company's.
  await admins.page.getByLabel('Email').fill(admin.email)
  await admins.page.getByLabel('Password', { exact: true }).fill(admin.temporaryPassword)
  await admins.page.getByRole('button', { name: 'Sign in' }).click()
  const password = `Q7-${tag}-identity-x9-Zr`
  await changeTemporaryPassword(admins.page, admin.temporaryPassword, password)
  await expect(admins.page.getByRole('heading', { level: 1, name: 'Admin dashboard' })).toBeVisible()
  await expect(admins.page).toHaveTitle(`Admin dashboard · ${company.name}`)
  expect(await shellBackground(admins.page)).toBe(rgb(surface))
  expect(await rootToken(admins.page, '--color-shell')).toBe(surface)
  expect(await rootToken(admins.page, '--color-accent')).toBe(surface)
  // The shell is a light surface: its texts are the dark ink, and the logo for light surfaces stands on
  // its white plate (the white logo for dark surfaces would not show on the orange).
  expect(await admins.page.locator('aside:visible, header[data-app-bar]:visible').first().evaluate((element) => getComputedStyle(element).color)).toBe(rgb(ink))
  const shellLogo = admins.page.locator('[data-identity-lockup="shell"]:visible img').first()
  await expect(shellLogo).toHaveAttribute('src', brand.logo_url!)
  await expect(shellLogo).toHaveAttribute('alt', company.name)
  expect(await admins.page.locator('[data-identity-lockup="shell"]:visible [data-logo-plate]').first().evaluate((plate) => getComputedStyle(plate).backgroundColor)).toBe('rgb(255, 255, 255)')
  await expect.poll(() => imageLoaded(admins.page, '[data-identity-lockup="shell"]:visible img')).toBe(true)
  expect(await productTraces(admins.page)).toEqual([])
  // The company's administrator has no way to change the identity: no such page in its navigation, none at its address.
  await expect(admins.page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: /identity|logo|colour/i })).toHaveCount(0)
  await expect(admins.page.getByRole('link', { name: 'Edit identity' })).toHaveCount(0)

  // An invitation: the company's logo and colour, its name, and nothing of the product.
  const api = Api.of(admins.context)
  const me = await api.me()
  expect(me.company.slug).toBe(slug)
  expect(me.company.brand).toEqual(brand)
  const visitorEmail = `visitor.${tag}@identity.test`
  const start = new Date(Date.now() + minutes(30))
  const created = await api.createVisit({ visitor: { full_name: `Sara Ahmad ${tag}`, email: visitorEmail }, start, end: new Date(start.getTime() + minutes(60)), sendInvitation: true })
  const invitation = await waitForMessage({ kind: 'VISITOR_INVITATION', to: visitorEmail })
  const logoOnTheServer = await admins.context.request.get(brand.logo_url!)
  expect(logoOnTheServer.headers()['content-type']).toBe('image/png')
  // The logo travels as opaque renditions (Phase 13, B13-2): the logo for light surfaces on a white plate, the
  // logo for dark surfaces on the dark header's colour, each no larger than twice its 168 × 44 box, with a plate of 8 CSS pixels (16 image pixels) on each side.
  const light = brandLogoImage(invitation)
  const dark = brandLogoDarkImage(invitation)
  expect(light, 'the e-mail has the company’s logo').not.toBeNull()
  expect(dark, 'and its logo for dark surfaces').not.toBeNull()
  for (const [rendition, what] of [[light!, 'light'], [dark!, 'dark']] as const) {
    const facts = pngFacts(rendition.bytes)
    expect(facts.seeThrough, `the ${what} rendition is opaque`).toBe(false)
    expect(facts.width, `the ${what} rendition's width`).toBeLessThanOrEqual(2 * 168 + 2 * 16)
    expect(facts.height, `the ${what} rendition's height`).toBeLessThanOrEqual(2 * 44 + 2 * 16)
  }
  // Each is the company's own logo: its colour is in the light one, on white; the dark one is on the dark header's colour.
  const lightPixels = await pngPixels(admins.page, light!.bytes, LOGO_COLOUR)
  const darkPixels = await pngPixels(admins.page, dark!.bytes, LOGO_COLOUR)
  expect(lightPixels.near, 'pixels of the logo’s own colour in the e-mail’s logo').toBeGreaterThan(50)
  expect(lightPixels.corner).toEqual([255, 255, 255])
  expect(darkPixels.corner).toEqual([0x18, 0x21, 0x26])
  // The e-mail's bar and button are the company's colour itself; what is written on white is the step that reads there.
  expect(invitation.html.toLowerCase()).toContain(surface)
  expect(invitation.html.toLowerCase()).toContain(strong)
  expect(invitation.subject).toContain(company.name)
  for (const part of [invitation.subject, invitation.html, invitation.text]) {
    expect(part).not.toContain('Mawdoo3')
    expect(part).not.toContain('موضوع')
  }
  // The pass link names its company; the token is the fragment alone.
  const passUrl = new URL(created.pass_url)
  expect(invitation.pass_url).toBe(created.pass_url)
  expect(passUrl.pathname).toBe('/pass')
  expect(passUrl.search).toBe(`?c=${slug}`)
  const token = passToken(created.pass_url)
  expect(token.length).toBeGreaterThanOrEqual(32)

  // The visitor's pass page, on a device that knows nothing: the company's identity, and no token anywhere but the address.
  const visitor = await open({ device: 'mobile' })
  const asked: string[] = []
  const leaks: string[] = []
  visitor.page.on('request', (request) => {
    const url = new URL(request.url())
    // The token in a request's address, in a header or in a body would be a leak.
    const sent = [request.url(), JSON.stringify(request.headers()), request.postData() ?? '']
    if (sent.some((part) => part.includes(token))) leaks.push(`${request.method()} ${url.pathname}`)
    if (url.pathname.startsWith('/api/')) asked.push(url.pathname.replace('/api/v1', ''))
  })
  await visitor.page.goto(`${passUrl.pathname}${passUrl.search}${passUrl.hash}`)
  await expect(visitor.page.getByRole('img', { name: 'Visitor pass QR code' })).toBeVisible()
  await expect(visitor.page.locator('[data-identity-lockup="page"] img')).toBeVisible()
  await expect(visitor.page).toHaveTitle(`Visitor pass · ${company.name}`)
  await expect.poll(() => imageLoaded(visitor.page, '[data-identity-lockup="page"] img')).toBe(true)
  // The card's head is the shell's colour: the company's.
  expect(await visitor.page.locator('#pass-title').evaluate((title) => getComputedStyle(title.parentElement!).backgroundColor)).toBe(rgb(surface))
  expect(await visitor.page.locator('#pass-title').evaluate((title) => getComputedStyle(title).color)).toBe(rgb(ink))
  await visitor.page.waitForLoadState('networkidle')
  expect(leaks, 'requests that carry the token').toEqual([])
  // The public brand and its files, and nothing else: no session check, no manifest. (The browser
  // may or may not report the tab icon's request: it is one of the brand's files.)
  const brandFiles = new Set([`/public/companies/${slug}/brand`, ...(['logo', 'logo_dark', 'icon'] as const).map((kind) => `/public/companies/${slug}/brand/${kind}.png`)])
  expect([...new Set(asked)].filter((path) => !brandFiles.has(path)), 'requests other than the public brand and its files').toEqual([])
  expect(asked).toEqual(expect.arrayContaining([`/public/companies/${slug}/brand`, `/public/companies/${slug}/brand/logo.png`]))
  await expect(visitor.page.locator('head link[rel="manifest"]')).toHaveCount(0)
  expect(await visitor.page.evaluate(() => JSON.stringify({ ...window.localStorage }))).not.toContain(token)
  expect(await productTraces(visitor.page)).toEqual([])
  // Signing out leads to the company's own sign-in page, in its identity: the device remembers its company.
  await admins.page.getByRole('button', { name: `Account menu for ${admin.name}` }).click()
  await admins.page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(admins.page).toHaveURL(signInLink)
  await expect(admins.page.getByRole('img', { name: company.name })).toBeVisible()
  await admins.page.goto('/login')
  await expect(admins.page).toHaveURL(signInLink)
  // A page of the app, signed out: back to that sign-in page, with the way to return.
  await admins.page.goto('/visits')
  await expect(admins.page).toHaveURL(`${signInLink}?next=%2Fvisits`)

  await platform.dispose()
})

test('the general sign-in page is nobody’s: no logo, no name, the neutral icon', async ({ open }) => {
  const { page } = await open({ device: 'desktop' })
  const asked: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) asked.push(url.pathname.replace('/api/v1', ''))
  })
  await page.goto('/login')
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
  await expect(page).toHaveTitle('Sign in')
  await expect(page.locator('[data-neutral-mark]')).toBeVisible()
  await expect(page.locator('main img')).toHaveCount(0)
  await expect(page.locator('[data-identity-lockup], [data-company-wordmark]')).toHaveCount(0)
  await expect(page.getByText('Mawdoo3')).toHaveCount(0)
  expect(await productTraces(page)).toEqual([])
  expect(await page.locator('head link[rel="icon"]').evaluateAll((links) => links.map((link) => link.getAttribute('href')))).toEqual(['/icons/neutral-16.png', '/icons/neutral-32.png', '/icons/neutral-48.png', '/icons/neutral-192.png'])
  await expect(page.locator('head link[rel="manifest"]')).toHaveCount(0)
  // The default colours, and no question about any company.
  expect(await rootToken(page, '--color-accent')).toBe('#188086')
  expect(asked.filter((path) => path.startsWith('/public/'))).toEqual([])

  // A slug nobody has is the same page: no error, no word about the company.
  await page.goto('/c/no-such-company-anywhere')
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible()
  await expect(page.locator('[data-neutral-mark]')).toBeVisible()
  await expect(page).toHaveTitle('Sign in')
  await expect(page.locator('main img')).toHaveCount(0)
  await expect(page.getByRole('alert').filter({ hasText: /.+/ })).toHaveCount(0)

  // The static page itself (what a link preview reads) names no product either, and links no manifest and no icon of the product.
  const shell = (await (await page.request.get('/login')).text()).replace(/<!--[\s\S]*?-->/g, '')
  expect(shell).not.toContain('Mawdoo3')
  expect(shell).not.toContain('موضوع')
  expect(shell).not.toMatch(/rel="manifest"/)
  expect([...shell.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map((link) => link[1]).filter((href) => !href!.startsWith('/icons/neutral-'))).toEqual([])
})

test('a company without an identity is its own name, in the default colours', async ({ open, apiAs }) => {
  const api = await apiAs('otherAdmin')
  const me: Me = await api.me()
  expect(me.company.brand).toMatchObject({ logo_url: null, logo_dark_url: null, icon_url: null, color: null, palette: null })
  const name = ACCOUNTS.otherAdmin.company

  const { page } = await open({ as: 'otherAdmin', device: 'desktop' })
  await page.goto('/admin')
  await expect(page.getByRole('heading', { level: 1, name: 'Admin dashboard' })).toBeVisible()
  // Its name as a wordmark at the head of the shell, and no image.
  const lockup = page.locator('[data-identity-lockup="shell"]:visible').first()
  await expect(lockup.locator('[data-company-wordmark]')).toHaveText(name)
  await expect(lockup.locator('img')).toHaveCount(0)
  await expect(page).toHaveTitle(`Admin dashboard · ${name}`)
  expect(await rootToken(page, '--color-shell')).toBe('#188086')
  expect(await rootToken(page, '--brand-light-accent')).toBe('')
  expect(await shellBackground(page)).toBe(rgb('#188086'))
  expect(await productTraces(page)).toEqual([])

  // Its sign-in page: the same wordmark, for someone who is not signed in.
  const signedOut = await open({ device: 'desktop' })
  await signedOut.page.goto(`/c/${me.company.slug}`)
  await expect(signedOut.page.locator('[data-identity-lockup="page"] [data-company-wordmark]')).toHaveText(name)
  await expect(signedOut.page).toHaveTitle(`Sign in · ${name}`)
  await expect(signedOut.page.locator('main img')).toHaveCount(0)
  expect(await productTraces(signedOut.page)).toEqual([])
})

test('the seeded company keeps the identity its seed gave it: its own logo and colour, as a company’s', async ({ open, apiAs }) => {
  const api = await apiAs('admin')
  const me = await api.me()
  const brand = me.company.brand
  expect(brand.color).toBe('#188086')
  expect(brand.logo_url).toBeTruthy()
  expect(brand.logo_dark_url).toBeTruthy()
  expect(brand.icon_url).toBeTruthy()

  const { page } = await open({ as: 'admin', device: 'desktop' })
  await page.goto('/admin')
  await expect(page.getByRole('heading', { level: 1, name: 'Admin dashboard' })).toBeVisible()
  // The logo comes from the API as any company's does, never from the product's own files.
  const logo = page.locator('[data-identity-lockup="shell"]:visible img').first()
  await expect(logo).toHaveAttribute('src', brand.logo_dark_url!)
  await expect(logo).toHaveAttribute('alt', ACCOUNTS.admin.company)
  await expect.poll(() => imageLoaded(page, '[data-identity-lockup="shell"]:visible img')).toBe(true)
  await expect(page).toHaveTitle(`Admin dashboard · ${ACCOUNTS.admin.company}`)
  // The seed's teal carries white text: the shell is the colour itself, as before.
  expect(brand.palette!.surface).toBe('#188086')
  expect(await rootToken(page, '--color-shell')).toBe(brand.palette!.surface)
  expect(await productTraces(page)).toEqual([])
})

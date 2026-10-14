import type { BrowserContext, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { CompanyBrand, PlatformCompany, PlatformCompanyCreated } from '../../src/types/api.ts'
import { Api, ApiStatusError } from './api.ts'
import { E2E_DIR } from './paths.ts'
import { strongPassword } from './ui.ts'

/*
 * A company of a spec's own with an identity (Phase 12). A company's logo and colour are
 * company-wide and show on every page of its people, so no spec changes those of a seeded company:
 * the main E2E company keeps the identity the seed gave it, and Other Corp stays without one.
 */

export const FIXTURES_DIR = path.join(E2E_DIR, 'fixtures')
/** A wordmark with empty room around it, 760 × 300 px: the browser cuts the room away. */
export const LOGO_PNG = path.join(FIXTURES_DIR, 'identity-logo.png')
/** The same wordmark in white, as an SVG: the browser rasterises it. */
export const LOGO_DARK_SVG = path.join(FIXTURES_DIR, 'identity-logo-dark.svg')
/** A 512 px square icon. */
export const ICON_PNG = path.join(FIXTURES_DIR, 'identity-icon.png')
/** A text file named like a picture. */
export const NOT_AN_IMAGE = path.join(FIXTURES_DIR, 'not-an-image.png')
/** The logo's own colour: what the identity page finds in its pixels. */
export const LOGO_COLOUR = '#f97316'

/** Colours a palette must stay readable with (the contract's awkward cases). */
export const AWKWARD_COLOURS = { yellow: '#f7b916', black: '#000000', veryLight: '#f5f0e6' } as const

export interface OwnCompany {
  company: PlatformCompany
  admin: { name: string; email: string; temporaryPassword: string }
}

/** A new company with its first administrator, made by the platform owner. */
export async function createCompany(platform: Api, tag: string, { name = `Petra ${tag}`, nameAr = `البتراء ${tag}` }: { name?: string; nameAr?: string | null } = {}): Promise<OwnCompany> {
  const admin = { name: `Nadia Haddad ${tag}`, email: `nadia.${tag}@identity.test`, temporaryPassword: strongPassword() }
  const created = await platform.ok<PlatformCompanyCreated>('POST', '/platform/companies', {
    name,
    name_ar: nameAr,
    slug: `identity-${tag}`,
    timezone: 'Asia/Amman',
    default_language: 'en',
    admin: { full_name: admin.name, email: admin.email, temporary_password: admin.temporaryPassword },
  })
  return { company: created.company, admin }
}

/** Stores a brand file through the API: the PNG as the raw body, as the identity page sends it. */
export async function putBrandAsset(platform: Api, companyId: string, kind: 'logo' | 'logo_dark' | 'icon', file: string): Promise<CompanyBrand> {
  const requestPath = `/platform/companies/${companyId}/brand/assets/${kind}`
  const response = await platform.putPng(requestPath, readFileSync(file))
  if (!response.ok()) throw new ApiStatusError('PUT', requestPath, response.status(), await response.text())
  return (await response.json()) as CompanyBrand
}

/** Sets (or, with null, removes) a company's colour; the server derives the palette. */
export function setBrandColour(platform: Api, companyId: string, color: string | null): Promise<CompanyBrand> {
  return platform.ok<CompanyBrand>('PATCH', `/platform/companies/${companyId}/brand`, { color })
}

/**
 * Signs a new administrator in through the API and replaces the temporary password, so the browser
 * context holds a usable session (the forced change through the UI is the platform scenario's).
 */
export async function signInFirstTime(context: BrowserContext, email: string, temporaryPassword: string): Promise<{ api: Api; password: string }> {
  const password = strongPassword()
  const signedIn = await context.request.post('/api/v1/auth/login', { data: { email, password: temporaryPassword } })
  if (!signedIn.ok()) throw new Error(`Signing in ${email} failed: ${signedIn.status()} ${await signedIn.text()}`)
  const api = Api.of(context)
  await api.ok('POST', '/auth/change-password', { current_password: temporaryPassword, new_password: password })
  return { api, password }
}

/** A colour as the browser computes it (`rgb(r, g, b)`), for comparing with a palette's `#rrggbb`. */
export function rgb(hex: string): string {
  const channel = (index: number) => Number.parseInt(hex.slice(index, index + 2), 16)
  return `rgb(${channel(1)}, ${channel(3)}, ${channel(5)})`
}

/** The background the shell is painted with: the sidebar on a desktop, the top bar below. */
export function shellBackground(page: Page): Promise<string> {
  return page.locator('aside:visible, header[data-app-bar]:visible').first().evaluate((element) => getComputedStyle(element).backgroundColor)
}

/** A design token as the page resolves it on its root (`--color-accent`), trimmed. */
export function rootToken(page: Page, name: string): Promise<string> {
  return page.evaluate((token) => getComputedStyle(document.documentElement).getPropertyValue(token).trim(), name)
}

/** Whether an image on the page has loaded with pixels (not a broken image). */
export function imageLoaded(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).first().evaluate((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0)
}

/** Everything of the product that a page of a company, or of nobody, must not show. */
export async function productTraces(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const traces: string[] = []
    const words = `${document.title}\n${document.body.innerText}`
    for (const word of ['Mawdoo3 Visitors', 'زوار موضوع']) if (words.includes(word)) traces.push(`the words “${word}”`)
    if (document.querySelector('[data-brand-lockup], [data-brand-logo]')) traces.push('the product’s lockup or logo')
    for (const image of document.querySelectorAll('img, source')) {
      const address = image.getAttribute('src') ?? image.getAttribute('srcset') ?? ''
      if (address.startsWith('/brand/')) traces.push(`an image of the product: ${address}`)
    }
    for (const link of document.head.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')) {
      const address = link.getAttribute('href') ?? ''
      if (address === '/manifest.webmanifest' || (address.startsWith('/icons/') && !address.startsWith('/icons/neutral-'))) traces.push(`in the head: ${address}`)
    }
    return traces
  })
}

import type { Page, Route } from '@playwright/test'
import type { Language } from '../../src/i18n/languages.ts'
import type { CompanyBrand, Me, PlatformCompany, PlatformMe, PublicCompanyBrand, Role, Visit } from '../../src/types/api.ts'
import { mockPalette } from './mock-brand.ts'

/*
 * A company with an identity for the layout specs that mock the API (Phase 12, the UX review's
 * fixes): its colour with the server's own palette, its files as the spec draws them, its session
 * and its public brand. A spec needs only the Vite server.
 */

export const uuid = (prefix: string, index: number) => `${prefix}000000-0000-4000-8000-${String(index).padStart(12, '0')}`

export interface MockCompany {
  slug: string
  name: string
  name_ar: string | null
  /** The company's colour (`#rrggbb`), or null: the default palette. */
  colour: string | null
}

/** The files of a company's identity, as PNG bytes; a kind that is left out is a file the company does not have. */
export interface MockFiles {
  logo?: Buffer
  logo_dark?: Buffer
  icon?: Buffer
}

export const COMPANY_ID = uuid('9b', 1)

export function brandOf(company: MockCompany, files: MockFiles = {}): CompanyBrand {
  const file = (kind: keyof MockFiles) => (files[kind] ? `/api/v1/public/companies/${company.slug}/brand/${kind}.png?v=v1` : null)
  return {
    logo_url: file('logo'),
    logo_dark_url: file('logo_dark'),
    icon_url: file('icon'),
    color: company.colour,
    palette: company.colour ? mockPalette(company.colour) : null,
    version: 'v1',
  }
}

export const publicBrandOf = (company: MockCompany, files: MockFiles = {}): PublicCompanyBrand => ({
  slug: company.slug,
  name: company.name,
  name_ar: company.name_ar,
  default_language: 'en',
  brand: brandOf(company, files),
})

export function meOf(company: MockCompany, language: Language, files: MockFiles = {}, roles: Role[] = ['SYSTEM_ADMIN', 'EMPLOYEE', 'RECEPTIONIST']): Me {
  return {
    user: { id: uuid('00', 1), full_name: 'Lina Haddad', email: 'lina.haddad@example.com', phone: null, roles, department: null, must_change_password: false, preferred_language: language },
    company: { id: COMPANY_ID, name: company.name, name_ar: company.name_ar, slug: company.slug, timezone: 'Asia/Amman', default_language: 'en', brand: brandOf(company, files), address: null, address_ar: null },
  }
}

export const platformMeOf = (language: Language): PlatformMe => ({ admin: { id: uuid('9a', 1), full_name: 'Platform Owner', email: 'platform@demo.local', must_change_password: false, preferred_language: language } })

export const platformCompanyOf = (company: MockCompany, files: MockFiles = {}): PlatformCompany => ({
  id: COMPANY_ID,
  name: company.name,
  name_ar: company.name_ar,
  slug: company.slug,
  timezone: 'Asia/Amman',
  default_language: 'en',
  is_active: true,
  deactivated_at: null,
  created_at: '2026-10-13T08:00:00Z',
  updated_at: '2026-10-13T08:00:00Z',
  counts: { active_users: 12, visits_last_30_days: 84 },
  brand: brandOf(company, files),
})

const iso = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

/** A visit of the signed-in host, `offset` minutes from now. */
export function mockVisit(index: number, name: string, company: string | null, status: Visit['status'], offset: number): Visit {
  const actor = { id: uuid('00', 1), full_name: 'Lina Haddad' }
  const arrived = status === 'CHECKED_IN' || status === 'CHECKED_OUT'
  return {
    id: uuid('aa', index),
    status,
    visitor: { id: uuid('bb', index), full_name: name, company_name: company },
    host: { id: uuid('00', 1), full_name: 'Lina Haddad', phone: '+962 79 000 0001' },
    department: { id: uuid('dd', 1), name: 'Operations', name_ar: null },
    purpose: 'Quarterly review',
    scheduled_start: iso(offset),
    scheduled_end: iso(offset + 60),
    window_start: iso(offset - 60),
    window_end: iso(offset + 120),
    is_walk_in: false,
    walk_in_reason: null,
    check_in_at: arrived ? iso(offset + 2) : null,
    check_in_method: arrived ? 'QR' : null,
    check_in_note: null,
    checked_in_by: arrived ? actor : null,
    check_out_at: status === 'CHECKED_OUT' ? iso(offset + 50) : null,
    check_out_method: status === 'CHECKED_OUT' ? 'MANUAL' : null,
    check_out_note: null,
    checked_out_by: status === 'CHECKED_OUT' ? actor : null,
    cancelled_at: null,
    cancellation_reason: null,
    cancelled_by: null,
    no_show_at: null,
    duration_seconds: status === 'CHECKED_OUT' ? 2880 : null,
    is_overdue: false,
    is_stale: false,
    created_by: actor,
    created_at: iso(-600),
    updated_at: iso(-600),
    invitation: { status: 'NOT_SENT', to_email: null, attempts: 0, last_attempt_at: null, sent_at: null, error: null, calendar_failed: false },
    last_notice: null,
    calendar_sequence: 0,
    visitor_calendar_sent: false,
    pass: { status: 'ACTIVE', issued_at: iso(-600), revoke_reason: null },
    permissions: { can_edit: true, can_cancel: true, can_resend: true, can_check_in: false, can_check_out: false },
  }
}

export const MOCK_VISITS: Visit[] = [
  mockVisit(1, 'Marco Rossi', 'Express Courier', 'CHECKED_IN', -20),
  mockVisit(2, 'Khalid Mansour', 'Blue Falcon Trading', 'SCHEDULED', 45),
  mockVisit(3, 'هند العبدالله', null, 'SCHEDULED', 120),
]

export const notMocked = (route: Route) => route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not mocked.', details: {} }, request_id: 'e2e' } })
const signedOut = (route: Route) => route.fulfill({ status: 401, json: { error: { code: 'NOT_AUTHENTICATED', message: 'Please sign in.', details: {} }, request_id: 'e2e' } })

export interface MockApiOptions {
  company: MockCompany
  files?: MockFiles
  /** The language of the signed-in user; null: nobody is signed in. */
  signedIn?: Language | null
  /** The language of the signed-in platform owner; null: nobody. */
  platform?: Language | null
  /** Holds an answer back until the test lets it go. */
  hold?: { path: string; release: Promise<void> }
  /** What the identity page sent (PUT, DELETE and PATCH of a brand). */
  sent?: { method: string; path: string; contentType: string | undefined; body: Buffer | null }[]
  /** More answers, by path (without `/api/v1`): tried before the ones below. */
  extra?: (path: string, route: Route) => Promise<void> | undefined
}

/** Answers the API for one company: its public brand and files, its session, its platform page. */
export async function mockCompanyApi(page: Page, { company, files = {}, signedIn = null, platform = null, hold, sent, extra }: MockApiOptions): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api/v1', '')
    if (hold && path === hold.path) await hold.release
    const answered = extra?.(path, route)
    if (answered) return answered

    const file = /^\/public\/companies\/([a-z0-9-]+)\/brand\/(logo|logo_dark|icon)\.png$/.exec(path)
    if (file) {
      const body = file[1] === company.slug ? files[file[2] as keyof MockFiles] : undefined
      return body ? route.fulfill({ status: 200, contentType: 'image/png', body }) : notMocked(route)
    }
    const brand = /^\/public\/companies\/([a-z0-9-]+)\/brand$/.exec(path)
    if (brand) return brand[1] === company.slug ? route.fulfill({ json: publicBrandOf(company, files) }) : notMocked(route)
    if (path.endsWith('/manifest.webmanifest')) return route.fulfill({ status: 200, contentType: 'application/manifest+json', body: '{"name":"Company","icons":[]}' })

    if (path === '/auth/me') return signedIn ? route.fulfill({ json: meOf(company, signedIn, files) }) : signedOut(route)
    if (path === '/dashboard/employee') return route.fulfill({ json: { counts: { today: 3, upcoming: 5, inside: 1, completed_30d: 12, cancelled_30d: 2, needs_attention: 1 }, today: MOCK_VISITS } })
    if (path === '/visits') return route.fulfill({ json: { items: MOCK_VISITS, page: 1, page_size: 25, total: MOCK_VISITS.length } })

    if (path === '/platform/auth/me') return platform ? route.fulfill({ json: platformMeOf(platform) }) : signedOut(route)
    if (path === '/platform/brand/palette') return route.fulfill({ json: mockPalette((request.postDataJSON() as { color: string }).color) })
    if (path === `/platform/companies/${COMPANY_ID}`) return route.fulfill({ json: platformCompanyOf(company, files) })
    if (path.startsWith(`/platform/companies/${COMPANY_ID}/brand`) && request.method() !== 'GET') {
      sent?.push({ method: request.method(), path, contentType: request.headers()['content-type'], body: request.postDataBuffer() })
      return route.fulfill({ json: brandOf(company, files) })
    }
    return notMocked(route)
  })
}

/** An answer held back until `release()` is called. */
export function gate(): { held: Promise<void>; release: () => void } {
  const lock: { open?: () => void } = {}
  const held = new Promise<void>((resolve) => {
    lock.open = resolve
  })
  return { held, release: () => lock.open?.() }
}

export interface DrawnFile {
  name: string
  mimeType: string
  buffer: Buffer
}

/**
 * A picture drawn on a canvas in the page, as a file to choose or to serve: `paint` is the body of a
 * function of the 2D context `x` and the canvas's width `w` and height `h`. Drawn rather than kept
 * as a fixture, so a spec says what is in the picture it tests with.
 */
export async function drawFile(page: Page, name: string, width: number, height: number, paint: string, type: 'image/png' | 'image/jpeg' = 'image/png'): Promise<DrawnFile> {
  const base64 = await page.evaluate(
    ([canvasWidth, canvasHeight, mime, source]) => {
      const canvas = document.createElement('canvas')
      canvas.width = canvasWidth
      canvas.height = canvasHeight
      // The spec's own drawing code, run in the page: nothing of the app.
      // oxlint-disable-next-line no-new-func
      new Function('x', 'w', 'h', source)(canvas.getContext('2d'), canvasWidth, canvasHeight)
      return canvas.toDataURL(mime, 0.9).split(',')[1]!
    },
    [width, height, type, paint] as const,
  )
  return { name, mimeType: type, buffer: Buffer.from(base64, 'base64') }
}

/** The pixels of a PNG, read back in the page: its size, and the colour at points given as shares of its width and height. */
export function readPng(page: Page, bytes: Buffer, points: readonly (readonly [number, number])[]): Promise<{ width: number; height: number; pixels: number[][] }> {
  return page.evaluate(
    async ([base64, at]) => {
      const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob()
      const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none' })
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      const pixels = at.map(([u, v]) => Array.from(context.getImageData(Math.min(bitmap.width - 1, Math.floor(u * bitmap.width)), Math.min(bitmap.height - 1, Math.floor(v * bitmap.height)), 1, 1).data))
      return { width: bitmap.width, height: bitmap.height, pixels }
    },
    [bytes.toString('base64'), points] as const,
  )
}

/** The shell on screen: the sidebar on a desktop, the top bar below. */
export const shellOf = (page: Page) => page.locator('aside:visible, header[data-app-bar]:visible').first()

/** A custom property of the root element as the browser resolves it. */
export const rootToken = (page: Page, name: string) => page.evaluate((property) => getComputedStyle(document.documentElement).getPropertyValue(property).trim(), name)

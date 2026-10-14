import { companySignInPath, isCompanySignInPage } from '../identity/links'
import { readRememberedCompany } from '../identity/storage'
import { paths, PRIVATE_PARAMS } from '../paths'
import type { Me } from '../types/api'
import { landingPath } from './roles'

/** Public pages that must never be a post-login destination. */
const NON_DESTINATIONS = new Set<string>([paths.login, paths.forgotPassword, paths.resetPassword, paths.pass])

/**
 * Pages used without a session (sign-in, a company's own sign-in page `/c/{slug}`, password reset,
 * the visitor pass): a session change elsewhere leaves them alone, and none is ever where a sign-in leads.
 */
export function isPublicPage(pathname: string): boolean {
  return NON_DESTINATIONS.has(pathname) || isCompanySignInPage(pathname)
}

/**
 * The sign-in page of this device (Phase 12): its company's own (`/c/{slug}`) once someone has signed
 * in here, else the neutral `/login`. A sign-out, an expired session and another tab's sign-out lead here.
 */
export function signInPath(): string {
  const slug = readRememberedCompany()
  return slug ? companySignInPath(slug) : paths.login
}

/**
 * The platform owner's pages (`/platform`, `/platform/…`, Phase 11): another principal's area with a
 * session of its own. The company session never sends anyone there or away from there.
 */
export function isPlatformPage(pathname: string): boolean {
  return pathname === paths.platform || pathname.startsWith(`${paths.platform}/`)
}

/**
 * Backslashes are normalised to "/" by browsers ("/\evil.com" → "//evil.com"), and
 * control characters (tab, newline) are stripped by the URL parser, so both are refused.
 */
function hasUnsafeCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f || code === 0x5c) return true
  }
  return false
}

/** A root-relative path that no consumer can read as protocol-relative ("//host", "/\host"). */
function isRootRelativePath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.includes('\\')
}

/**
 * Validates a `?next=` value: only same-origin, relative paths are accepted (no
 * protocol-relative "//host", no absolute URLs, no backslash tricks). Returns the
 * normalised path + query, or null. Fragments are dropped (they may carry tokens), and so are
 * private parameters (`PRIVATE_PARAMS`: search text, names), which must not reach an address.
 *
 * The check runs on the normalised path that is returned, not only on the input: dot
 * segments collapse into a protocol-relative path ("/.//evil.com", "/%2e//evil.com" and
 * "/x/..//evil.com" all normalise to "//evil.com").
 */
export function safeNextPath(next: string | null | undefined, origin: string = window.location.origin): string | null {
  // A platform page is never a company sign-in's destination: it belongs to the other session.
  return normalisedNextPath(next, origin, (pathname) => !isPublicPage(pathname) && !isPlatformPage(pathname))
}

/**
 * The checks of `safeNextPath` without its choice of destinations: a same-origin, root-relative path
 * and query, normalised, without fragment and private parameters, whose normalised pathname
 * `allowed` accepts; else null. The platform owner's sign-in (Phase 11) allows platform pages only.
 */
export function normalisedNextPath(next: string | null | undefined, origin: string, allowed: (pathname: string) => boolean): string | null {
  if (!next || !isRootRelativePath(next) || hasUnsafeCharacters(next)) return null
  let url: URL
  try {
    url = new URL(next, origin)
  } catch {
    return null
  }
  if (url.origin !== origin || !isRootRelativePath(url.pathname) || !allowed(url.pathname)) return null
  if (PRIVATE_PARAMS.some((key) => url.searchParams.has(key))) {
    for (const key of PRIVATE_PARAMS) url.searchParams.delete(key)
  }
  return `${url.pathname}${url.search}`
}

/** Where to go after signing in: forced password change first, then `next`, then the landing page. */
export function postLoginPath(me: Me, next: string | null): string {
  if (me.user.must_change_password) return paths.changePassword
  return next ?? landingPath(me.user.roles)
}

/**
 * The device's sign-in page with `?next=<current path>` (without it when there is nothing worth
 * returning to): `/c/{slug}?next=…` for a device that remembers its company, else `/login?next=…`.
 */
export function loginPath(location: { pathname: string; search: string }): string {
  const next = safeNextPath(`${location.pathname}${location.search}`)
  const signIn = signInPath()
  if (!next || next === paths.home) return signIn
  return `${signIn}?${new URLSearchParams({ next }).toString()}`
}

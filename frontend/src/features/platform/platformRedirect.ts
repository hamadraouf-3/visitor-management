import { isPlatformPage, normalisedNextPath } from '../../auth/redirect'
import { paths } from '../../paths'
import type { PlatformMe } from '../../types/api'

/**
 * A `?next=` for the platform sign-in: a same-origin platform page only, with the checks of the
 * company sign-in's `safeNextPath` (which refuses platform pages), never the sign-in itself.
 */
export function safePlatformNextPath(next: string | null | undefined, origin: string = window.location.origin): string | null {
  return normalisedNextPath(next, origin, (pathname) => isPlatformPage(pathname) && pathname !== paths.platformLogin)
}

/** Where the platform owner goes after signing in: the forced change first, then `next`, then the companies. */
export function postPlatformLoginPath(me: PlatformMe, next: string | null): string {
  if (me.admin.must_change_password) return paths.platformChangePassword
  return next ?? paths.platformCompanies
}

/** `/platform/login?next=<current page>` (plain when there is nothing worth returning to). */
export function platformLoginPath(location: { pathname: string; search: string }): string {
  const next = safePlatformNextPath(`${location.pathname}${location.search}`)
  if (!next || next === paths.platform || next === paths.platformCompanies) return paths.platformLogin
  return `${paths.platformLogin}?${new URLSearchParams({ next }).toString()}`
}

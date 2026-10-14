import { paths } from '../paths'
import { isCompanySlug } from './brand'

/*
 * A company in an address (Phase 12). Its sign-in page is `/c/{slug}` (also `/c/{slug}/login`); the
 * sign-in, forgot-password, reset-password and pass pages take `?c={slug}`. The parameter carries
 * the slug only, never anything of a person or a token.
 */

/** The query parameter that names a company on the public pages. */
export const COMPANY_PARAM = 'c'

const COMPANY_PAGE = /^\/c\/([^/]+)(?:\/login)?\/?$/

/** Whether a path is a company's sign-in page (`/c/{slug}`, `/c/{slug}/login`), whatever the slug. */
export function isCompanySignInPage(pathname: string): boolean {
  return COMPANY_PAGE.test(pathname)
}

/** A company's sign-in page: the link the platform owner hands out. */
export function companySignInPath(slug: string): string {
  return paths.companySignIn(slug)
}

/** The sign-in page a signed-out page links to: the company's own when the address names one, else `/login`. */
export function signInPathFor(slug: string | null): string {
  return slug ? paths.companySignIn(slug) : paths.login
}

/** The slug an address names (`/c/{slug}`, or `?c={slug}`), when it is a slug at all; else null. */
export function companySlugOf(location: { pathname: string; search: string }): string | null {
  const fromPath = COMPANY_PAGE.exec(location.pathname)?.[1]
  if (fromPath !== undefined) {
    try {
      const slug = decodeURIComponent(fromPath)
      return isCompanySlug(slug) ? slug : null
    } catch {
      return null
    }
  }
  const fromQuery = new URLSearchParams(location.search).get(COMPANY_PARAM)
  return isCompanySlug(fromQuery) ? fromQuery : null
}

/** `path` with `?c={slug}` (kept first, before the path's own parameters); the path itself without a slug. */
export function withCompany(path: string, slug: string | null): string {
  if (!slug) return path
  const [pathname = '', query = ''] = path.split('?')
  const parameters = new URLSearchParams(query)
  parameters.delete(COMPANY_PARAM)
  const rest = parameters.toString()
  return `${pathname}?${COMPANY_PARAM}=${encodeURIComponent(slug)}${rest ? `&${rest}` : ''}`
}

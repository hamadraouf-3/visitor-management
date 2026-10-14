import { isPlatformPage } from '../auth/redirect'
import type { Language } from '../i18n/languages'
import { companyDisplayName } from '../i18n/session'
import { paths } from '../paths'
import type { CompanyBrand, Me, PublicCompanyBrand } from '../types/api'
import { isCompanySlug, parseCompanyBrand } from './brand'
import { companySlugOf, isCompanySignInPage } from './links'

/*
 * Whose identity a page shows (Phase 12):
 *
 * - the platform owner's area (`/platform/…`): the product's, as before;
 * - the visitor's pass (`/pass`): the company its link names (`?c={slug}`), from the public brand
 *   endpoint only; the session is never looked at there;
 * - signed in: the session's company;
 * - signed out, on a company's sign-in page (`/c/{slug}`) or with `?c={slug}`: that company's, from
 *   the public brand endpoint; a slug nobody has is the neutral page;
 * - otherwise neutral: no logo, no name.
 */

export type Identity =
  | { kind: 'product' }
  | { kind: 'neutral' }
  | {
      kind: 'company'
      /** Null when the session's company came without a slug (an older API): no sign-in link, no manifest. */
      slug: string | null
      name: string
      nameAr: string | null
      brand: CompanyBrand
    }

export type CompanyIdentity = Extract<Identity, { kind: 'company' }>

export const PRODUCT: Identity = { kind: 'product' }
export const NEUTRAL: Identity = { kind: 'neutral' }

/** Where an address lies: the platform owner's area, the visitor's pass, a page used signed out, or the app. */
export type Area = 'platform' | 'pass' | 'public' | 'app'

const SIGNED_OUT_PAGES = new Set<string>([paths.login, paths.forgotPassword, paths.resetPassword])

export function areaOf(pathname: string): Area {
  if (isPlatformPage(pathname)) return 'platform'
  if (pathname === paths.pass) return 'pass'
  if (SIGNED_OUT_PAGES.has(pathname) || isCompanySignInPage(pathname)) return 'public'
  return 'app'
}

/** The session's company as an identity. Its brand is validated: an older API, or a mocked session, has none. */
export function identityOfSession(me: Me): CompanyIdentity {
  const company = me.company as Me['company'] & { slug?: unknown; brand?: unknown }
  return {
    kind: 'company',
    slug: isCompanySlug(company.slug) ? company.slug : null,
    name: company.name,
    nameAr: typeof company.name_ar === 'string' && company.name_ar.trim() !== '' ? company.name_ar : null,
    brand: parseCompanyBrand(company.brand, company.slug),
  }
}

/** A company's public brand (already validated by `parsePublicBrand`) as an identity. */
export function identityOfPublicBrand(brand: PublicCompanyBrand): CompanyIdentity {
  return { kind: 'company', slug: brand.slug, name: brand.name, nameAr: brand.name_ar, brand: brand.brand }
}

/** The company's name in the UI language: its Arabic name in Arabic when it has one. */
export function identityName(identity: CompanyIdentity, language: Language): string {
  return companyDisplayName({ name: identity.name, name_ar: identity.nameAr }, language)
}

export interface IdentityInputs {
  pathname: string
  search: string
  /** The session as the cache has it: undefined while it is not known, null when nobody is signed in. */
  me: Me | null | undefined
  /**
   * The public brand of the company the address names: undefined while it is not known (no answer
   * yet and no copy on this device), null when no active company has that slug.
   */
  publicBrand: PublicCompanyBrand | null | undefined
  /** This device's copy of the identity of the company it last signed in to, or null. */
  remembered: PublicCompanyBrand | null
}

export interface ResolvedIdentity {
  identity: Identity
  /** The address names a company whose identity is not known yet: nothing of an identity is drawn meanwhile. */
  pending: boolean
  /** The company the address names (`/c/{slug}`, `?c=`): the links between the signed-out pages keep it. */
  linkSlug: string | null
}

export function resolveIdentity({ pathname, search, me, publicBrand, remembered }: IdentityInputs): ResolvedIdentity {
  const area = areaOf(pathname)
  const linkSlug = area === 'platform' ? null : companySlugOf({ pathname, search })
  if (area === 'platform') return { identity: PRODUCT, pending: false, linkSlug }

  const named = (): ResolvedIdentity => {
    if (linkSlug === null) return { identity: NEUTRAL, pending: false, linkSlug }
    if (publicBrand) return { identity: identityOfPublicBrand(publicBrand), pending: false, linkSlug }
    return { identity: NEUTRAL, pending: publicBrand === undefined, linkSlug }
  }

  // The pass is the visitor's page: its company is the one its link names, whoever uses this device.
  if (area === 'pass') return named()
  if (me) return { identity: identityOfSession(me), pending: false, linkSlug }
  if (linkSlug !== null) return named()
  // A page of the app while the session is not known yet: the device's own company meanwhile, so
  // the page does not start in the default colours and change a moment later.
  if (area === 'app' && me === undefined && remembered) return { identity: identityOfPublicBrand(remembered), pending: false, linkSlug }
  return { identity: NEUTRAL, pending: false, linkSlug }
}

/** Whether a page needs the public brand endpoint for the company its address names. */
export function needsPublicBrand({ pathname, search, me }: Pick<IdentityInputs, 'pathname' | 'search' | 'me'>): string | null {
  const area = areaOf(pathname)
  if (area === 'platform') return null
  const slug = companySlugOf({ pathname, search })
  if (slug === null) return null
  return area === 'pass' || !me ? slug : null
}

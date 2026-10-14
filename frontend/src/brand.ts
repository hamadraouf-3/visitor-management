import type { Language } from './i18n/languages'

/**
 * The product and its brand (F10-8, F10-27), which since Phase 12 belong to the platform owner's
 * area alone.
 *
 * - The PRODUCT is «زوار موضوع» in Arabic and "Mawdoo3 Visitors" in English (`productName`): the
 *   document titles of the platform owner's pages ("<page> · Mawdoo3 Visitors"), the installed app
 *   of that area, and the lockup under the logo on its sign-in page and in its shell.
 * - The BRAND is «موضوع» / "Mawdoo3" with its logo (`name`): the logo's own text alternative.
 * - A COMPANY (a tenant, Mawdoo3 among them) has an identity of its own: its logo, its colour and
 *   its name (`src/identity`, `IdentityLockup`, `CompanyLogo`). Its staff and its visitors never see
 *   the product's name or logo, and a page that is nobody's (the neutral sign-in page) shows neither.
 *   `components/app/productBrandGuard.test.ts` holds that.
 *
 * The logo is the Arabic wordmark, 462 × 149 px on a transparent background, in three colours
 * (public/brand/): `teal` (#169897) on light surfaces, `white` on the shell and dark surfaces,
 * `ink` for single-colour use. The square app icons (favicon, PWA, Apple touch) are generated from
 * the white logo by `npm run icons`, beside the neutral ones every other page starts with.
 */
export const BRAND = {
  name: { ar: 'موضوع', en: 'Mawdoo3' },
  productName: { ar: 'زوار موضوع', en: 'Mawdoo3 Visitors' },
  /** The logo's teal (the app icons' tile). */
  color: '#169897',
  /** mawdoo3.com's side-nav teal: the default shell, and the browser's theme colour without a company's own. */
  themeColor: '#188086',
  logo: {
    teal: '/brand/logo-teal.png',
    white: '/brand/logo-white.png',
    ink: '/brand/logo-ink.png',
  },
  logoSize: { width: 462, height: 149 },
} as const

export type LogoVariant = keyof typeof BRAND.logo

/** The brand's name in a language («موضوع», "Mawdoo3"): the logo's text alternative. */
export function brandName(language: Language): string {
  return BRAND.name[language]
}

/** The product's name in a language («زوار موضوع», "Mawdoo3 Visitors"): the platform owner's titles and lockup. */
export function productName(language: Language): string {
  return BRAND.productName[language]
}

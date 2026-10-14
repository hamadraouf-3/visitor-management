import type { BrandPalette, CompanyBrand, PublicCompanyBrand } from '../types/api'
import { isLanguage } from '../i18n/languages'
import { contrast, isHexColour, luminance, WHITE } from './colour'

/*
 * A company's identity as the SPA reads it (Phase 12): its logos, its colour and the palette the
 * backend derived from it. Everything that arrives (the session, the public endpoint, the copy this
 * device kept) goes through the parsers below before anything is drawn with it: the addresses must be
 * the API's own brand files **of that company**, the colours `#rrggbb`, and the palette must keep the
 * contract's guarantees. What does not pass is left out, and the default identity shows instead: a
 * name as a wordmark, the default palette.
 */

/** The three files of an identity: the logo for light surfaces, the optional one for dark surfaces, the square icon. */
export const BRAND_ASSET_KINDS = ['logo', 'logo_dark', 'icon'] as const
export type BrandAssetKind = (typeof BRAND_ASSET_KINDS)[number]

/** A company's slug: 1–80 lowercase letters, digits and inner hyphens. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/

export function isCompanySlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_PATTERN.test(value)
}

/** A company without a logo and without a colour: its name as a wordmark, the default palette. */
export const EMPTY_BRAND: CompanyBrand = { logo_url: null, logo_dark_url: null, icon_url: null, color: null, palette: null, version: '' }

/** The contract's minimum ratios. */
const TEXT = 4.5
const DEEP_TEXT = 10
/** Both sides compute the same formula on the same bytes; this only absorbs the last float digit. */
const EPSILON = 1e-6

/** The roles a palette had before brand surfaces took the company's own colour: what an older answer, or a copy this device kept, still holds. */
const CORE_KEYS = ['strong', 'strong_hover', 'deep', 'bright', 'tint', 'tint_border', 'on_strong', 'on_bright'] as const satisfies readonly (keyof BrandPalette)[]
/** What brand surfaces are painted with, their ink and their hover step. */
const SURFACE_KEYS = ['surface', 'on_surface', 'surface_hover'] as const satisfies readonly (keyof BrandPalette)[]

/**
 * Whether a palette's surfaces are light: their ink is the dark one, not white. Everything drawn on
 * such a surface (the shell's texts, its current page, its focus ring, the logo) follows the ink.
 */
export function isLightSurface(palette: Pick<BrandPalette, 'surface' | 'on_surface'>): boolean {
  return luminance(palette.on_surface) < luminance(palette.surface)
}

/**
 * What a palette breaks of the contract's guarantees (empty: none). The SPA pairs only these roles as
 * text and background, so a palette that fails one is not used at all.
 */
export function paletteProblems(palette: BrandPalette): string[] {
  const problems: string[] = []
  const atLeast = (name: string, a: string, b: string, minimum: number) => {
    const ratio = contrast(a, b)
    if (ratio + EPSILON < minimum) problems.push(`${name}: ${ratio.toFixed(2)}:1 < ${minimum}:1`)
  }
  atLeast('white on strong', WHITE, palette.strong, TEXT)
  atLeast('white on strong_hover', WHITE, palette.strong_hover, TEXT)
  atLeast('on_strong on strong', palette.on_strong, palette.strong, TEXT)
  atLeast('on_strong on strong_hover', palette.on_strong, palette.strong_hover, TEXT)
  atLeast('white on deep', WHITE, palette.deep, DEEP_TEXT)
  atLeast('on_bright on bright', palette.on_bright, palette.bright, TEXT)
  atLeast('bright on deep', palette.bright, palette.deep, TEXT)
  atLeast('strong on tint', palette.strong, palette.tint, TEXT)
  atLeast('on_surface on surface', palette.on_surface, palette.surface, TEXT)
  atLeast('on_surface on surface_hover', palette.on_surface, palette.surface_hover, TEXT)
  // The ink of a surface is one of the two the app draws with: white, or the palette's dark ink.
  if (palette.on_surface !== WHITE && palette.on_surface !== palette.on_bright) problems.push('on_surface is neither white nor on_bright')
  // The roles' own words: dark ink on the bright step, a near-white tint, a bright step lighter than the deep one.
  if (luminance(palette.on_bright) >= luminance(palette.bright)) problems.push('on_bright is not darker than bright')
  if (luminance(palette.tint) <= luminance(palette.strong)) problems.push('tint is not lighter than strong')
  if (luminance(palette.bright) <= luminance(palette.deep)) problems.push('bright is not lighter than deep')
  return problems
}

/**
 * A palette whose colours are `#rrggbb` and which keeps every guarantee; else null.
 *
 * A palette without the three surface roles (an API older than them, a copy this device kept from
 * before) is completed as it was drawn then: its surfaces are `strong` under white, with
 * `strong_hover` as their step, which the older guarantees cover. The server's next answer replaces
 * it. A palette that names some of the three and not all is no palette.
 */
export function parseBrandPalette(value: unknown): BrandPalette | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!CORE_KEYS.every((key) => isHexColour(record[key]))) return null
  const core = Object.fromEntries(CORE_KEYS.map((key) => [key, record[key]])) as Pick<BrandPalette, (typeof CORE_KEYS)[number]>
  let palette: BrandPalette
  if (SURFACE_KEYS.every((key) => record[key] === undefined)) {
    palette = { surface: core.strong, on_surface: WHITE, surface_hover: core.strong_hover, ...core }
  } else {
    if (!SURFACE_KEYS.every((key) => isHexColour(record[key]))) return null
    palette = { surface: record.surface as string, on_surface: record.on_surface as string, surface_hover: record.surface_hover as string, ...core }
  }
  return paletteProblems(palette).length === 0 ? palette : null
}

const VERSION_PATTERN = /^[\w.~-]{1,128}$/

/**
 * The address of a brand file as the API writes it for the company `slug`: a same-origin path below
 * that company's public brand endpoint, for that kind, with an optional version. Anything else is
 * refused: another origin, another path, a `javascript:` or `data:` address, and **another
 * company's file** (a brand never shows a logo that is not its own company's, whatever an answer or
 * this device's storage says). An address read from storage is never trusted to be the API's.
 */
export function isBrandAssetUrl(value: unknown, kind: BrandAssetKind, slug: unknown): value is string {
  if (typeof value !== 'string' || value.length > 400 || !isCompanySlug(slug)) return false
  const [path, query, ...rest] = value.split('?')
  if (rest.length > 0 || path === undefined) return false
  const match = /^\/api\/v1\/public\/companies\/([^/]+)\/brand\/([a-z_]+)\.png$/.exec(path)
  if (!match || match[1] !== slug || match[2] !== kind) return false
  if (query === undefined) return true
  const parameters = query.split('&')
  return parameters.length === 1 && parameters[0]!.startsWith('v=') && VERSION_PATTERN.test(parameters[0]!.slice(2))
}

/**
 * The `CompanyBrand` of the company `slug` from an untrusted value (an older API's `Me` without one,
 * a mocked session, this device's storage). Each part stands on its own: a logo with a bad address,
 * or with another company's, is left out; a colour without a valid palette gives the default
 * palette. Without the company's slug no address can be its own, and none is kept.
 */
export function parseCompanyBrand(value: unknown, slug: unknown): CompanyBrand {
  if (!value || typeof value !== 'object') return EMPTY_BRAND
  const record = value as Record<string, unknown>
  const asset = (key: 'logo_url' | 'logo_dark_url' | 'icon_url', kind: BrandAssetKind) => (isBrandAssetUrl(record[key], kind, slug) ? record[key] : null)
  const palette = parseBrandPalette(record.palette)
  const color = palette && isHexColour(record.color) ? record.color : null
  return {
    logo_url: asset('logo_url', 'logo'),
    logo_dark_url: asset('logo_dark_url', 'logo_dark'),
    icon_url: asset('icon_url', 'icon'),
    color,
    palette: color ? palette : null,
    version: typeof record.version === 'string' && record.version.length <= 128 ? record.version : '',
  }
}

/** A name a person reads: text of a sane length, without control characters. */
function isDisplayName(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (text === '' || text.length > 200) return false
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/** The public brand of a company (GET /public/companies/{slug}/brand, or this device's copy of it); null when it is not one. */
export function parsePublicBrand(value: unknown): PublicCompanyBrand | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!isCompanySlug(record.slug) || !isDisplayName(record.name)) return null
  return {
    slug: record.slug,
    name: record.name.trim(),
    name_ar: isDisplayName(record.name_ar) ? record.name_ar.trim() : null,
    default_language: isLanguage(record.default_language) ? record.default_language : 'ar',
    brand: parseCompanyBrand(record.brand, record.slug),
  }
}

/** Whether two identities would draw the same thing. */
export function sameBrand(a: CompanyBrand, b: CompanyBrand): boolean {
  return (
    a.logo_url === b.logo_url &&
    a.logo_dark_url === b.logo_dark_url &&
    a.icon_url === b.icon_url &&
    a.color === b.color &&
    a.version === b.version &&
    JSON.stringify(a.palette) === JSON.stringify(b.palette)
  )
}

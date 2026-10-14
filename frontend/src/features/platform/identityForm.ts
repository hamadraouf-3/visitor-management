import { getFieldErrorCodes, getErrorMessage, isApiError } from '../../api/client'
import { isLightSurface, type BrandAssetKind } from '../../identity/brand'
import { normaliseHexColour } from '../../identity/colour'
import { imageProblemOf, LOGO_MAX_WIDE, MAX_SOURCE_BYTES, MIN_SOURCE_SIDE, NEUTRAL_TILE, type ImageProblem, type LetterTile } from '../../identity/imagePipeline'
import { DEFAULT_THEME_COLORS } from '../../identity/tokens'
import { catalogText } from '../../i18n/catalogText'
import type { Language } from '../../i18n/languages'
import { paths } from '../../paths'
import type { BrandPalette, CompanyBrand, PlatformCompany } from '../../types/api'
import { joinList, leadingLetter } from '../../utils/text'
import type { IdentityChanges } from './queries'

/* The identity page's form logic (Phase 12): pure, so the page stays about its screen. */

/** A picture chosen on the page, prepared and not saved yet. */
export interface AssetDraft {
  /** The PNG that will be uploaded. */
  blob: Blob
  /** An object URL of it, for the page's own previews; the page revokes it. */
  url: string
  width: number
  height: number
  /** The icon the page made (from the logo, or from the company's name), as opposed to one chosen by hand. */
  generated: boolean
  /** The icon the page made from the name: the letter and the colours it was drawn with. */
  tile?: LetterTile
}

/**
 * Where the saved icon came from, as far as this visit of the page knows: made here (a letter tile
 * with its colours, or the logo on white), chosen here by hand, or null: saved before this visit.
 * It is the page's own memory and nothing of the server's: an icon saved earlier is nobody's to
 * redraw, and it is only ever removed, with the logo, after one line that says so.
 */
export type IconOrigin = { by: 'page'; tile: LetterTile | null } | { by: 'hand' } | null

/** Where an icon that is being saved comes from. */
export function originOf(draft: AssetDraft): IconOrigin {
  return draft.generated ? { by: 'page', tile: draft.tile ?? null } : { by: 'hand' }
}

export function sameTile(a: LetterTile, b: LetterTile): boolean {
  return a.letter === b.letter && a.background === b.background && a.ink === b.ink
}

/**
 * The letter of a company's icon: the first of its name, in the language its people read first
 * (its Arabic name for a company whose default language is Arabic and that has one).
 */
export function iconLetter(company: Pick<PlatformCompany, 'name' | 'name_ar' | 'default_language'>): string {
  const arabic = company.default_language === 'ar' && company.name_ar ? leadingLetter(company.name_ar) : ''
  return arabic || leadingLetter(company.name) || leadingLetter(company.name_ar ?? '')
}

/** The letter tile of a company: its letter on its surface colour under that surface's ink; the neutral tile without a colour. */
export function letterTileOf(letter: string, palette: BrandPalette | null): LetterTile {
  return palette ? { letter, background: palette.surface, ink: palette.on_surface } : { letter, ...NEUTRAL_TILE }
}

/**
 * The colour the logo for dark surfaces is shown on: the company's shell where that is dark, else
 * its deep step (a light shell never carries that logo: the dark colour scheme's does).
 */
export function darkSurfaceOf(palette: BrandPalette | null): string {
  if (!palette) return DEFAULT_THEME_COLORS.light
  return isLightSurface(palette) ? palette.deep : palette.surface
}

export type AssetDrafts = Partial<Record<BrandAssetKind, AssetDraft>>

/** The colour the field holds: the typed text as `#rrggbb` (null: not a colour), and whether it may be saved. */
export interface ColourDraft {
  /** The colour to save: a hex colour, or null for none. */
  value: string | null
  valid: boolean
  changed: boolean
}

/**
 * The colour field against the saved colour. An empty field is "no colour", which is only what a
 * company without a colour has: a saved colour is removed with "Reset to default colour" (and its one
 * line of confirmation), not by emptying the field.
 */
export function colourDraft(text: string, saved: string | null): ColourDraft {
  const typed = text.trim()
  if (typed === '') return { value: null, valid: saved === null, changed: saved !== null }
  const value = normaliseHexColour(typed)
  return { value, valid: value !== null, changed: value !== saved }
}

/** What a save sends for the page's state; null when nothing changed. */
export function identityChanges(assets: AssetDrafts, colour: ColourDraft): IdentityChanges | null {
  const files = Object.fromEntries(Object.entries(assets).map(([kind, draft]) => [kind, draft.blob])) as IdentityChanges['assets']
  if (Object.keys(files).length === 0 && !colour.changed) return null
  return colour.changed ? { assets: files, color: colour.value } : { assets: files }
}

/** The address of a company's file as the page shows it: the unsaved picture, else the saved one. */
export function assetUrl(kind: BrandAssetKind, assets: AssetDrafts, brand: CompanyBrand): string | null {
  const saved = { logo: brand.logo_url, logo_dark: brand.logo_dark_url, icon: brand.icon_url }[kind]
  return assets[kind]?.url ?? saved
}

/** The identity as the preview draws it: the saved brand with the page's unsaved pictures over it. */
export function previewBrand(assets: AssetDrafts, brand: CompanyBrand): CompanyBrand {
  return { ...brand, logo_url: assetUrl('logo', assets, brand), logo_dark_url: assetUrl('logo_dark', assets, brand), icon_url: assetUrl('icon', assets, brand) }
}

/** The company's sign-in link as the platform owner hands it out: this origin's `/c/{slug}`. */
export function signInLink(slug: string, origin: string = window.location.origin): string {
  return `${origin}${paths.companySignIn(slug)}`
}

/** The formats the page names when a file is no image (the browser decodes more; these are the usual ones). */
export const IMAGE_FORMATS = ['PNG', 'JPEG', 'WebP', 'SVG'] as const

/** The formats as one line of text, with the language's own comma («PNG، JPEG، WebP، SVG»). */
export function imageFormats(language?: Language): string {
  return joinList(IMAGE_FORMATS, language)
}

/** What the file input offers: any image the browser can decode. */
export const IMAGE_ACCEPT = 'image/*,.svg'

const identityText = (key: string, options?: Record<string, unknown>) => catalogText('platform', `identity.problems.${key}`, options)

/** The text of a problem that is said differently per place: a logo that is too light names the place it belongs in. */
function problemKey(problem: ImageProblem, kind: BrandAssetKind): string {
  if (problem === 'too-light' && kind === 'icon') return 'too-light-icon'
  return problem
}

/** Why a chosen file was refused on this device for the place it was chosen for, in the UI language. */
export function preparationProblem(error: unknown, kind: BrandAssetKind = 'logo'): string {
  const problem = imageProblemOf(error) ?? 'undecodable'
  // A logo too light for white backgrounds belongs in the other place, and the reverse: the message names it.
  const other = catalogText('platform', `identity.logos.kinds.${kind === 'logo_dark' ? 'logo' : 'logo_dark'}`) ?? ''
  return (
    identityText(problemKey(problem, kind), {
      formats: imageFormats(),
      size: Math.round(MAX_SOURCE_BYTES / (1024 * 1024)),
      pixels: MIN_SOURCE_SIDE,
      times: LOGO_MAX_WIDE,
      slot: other,
    }) ?? ''
  )
}

/**
 * Why the server refused a prepared picture: its field code on `file` in the page's own words where
 * the page knows the code, the status for a body that is too large or of another type, else the
 * server's message.
 */
export function uploadProblem(error: unknown): string {
  const code = getFieldErrorCodes(error).file?.code
  const known = code ? identityText(code) : null
  if (known) return known
  if (isApiError(error) && error.status === 413) return identityText('image_too_large') ?? getErrorMessage(error)
  if (isApiError(error) && error.status === 415) return identityText('invalid_image') ?? getErrorMessage(error)
  return getErrorMessage(error)
}

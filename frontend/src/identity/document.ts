import { API_BASE_PATH } from '../api/client'
import type { BrandPalette } from '../types/api'
import { areaOf, type Identity } from './identity'
import { applyBrandVariables, brandTokens, PENDING_PALETTE, PLATFORM_THEME_COLORS, themeColors, type BrandTokens } from './tokens'

/*
 * An identity on the document itself (Phase 12): the palette's custom properties on the root
 * element, the browser chrome's colour, the tab's icon and the installable app's manifest.
 * `index.html` starts neutral (a neutral icon, no manifest, the default colours); this replaces
 * those for a company, and for the product in the platform owner's area. Everything is set through
 * the DOM and the CSSOM: the page's style policy allows no inline style.
 */

/** What the document's head says for an identity. */
export interface DocumentIdentity {
  palette: BrandPalette | null
  /** The browser chrome's colour in each scheme: the shell the pages are drawn in (the platform's own in its area). */
  themeColors: { light: string; dark: string }
  /** The tab's icon: the product's set, the neutral set, or a company's own square icon. */
  icons: 'product' | 'neutral' | { url: string }
  /** The web app manifest's address, or null: nothing to install. */
  manifest: string | null
}

export const PRODUCT_MANIFEST = '/manifest.webmanifest'

/** A company's own web app manifest (its name, its colours, its icon; `start_url` its sign-in page). */
export function companyManifestUrl(slug: string): string {
  return `${API_BASE_PATH}/public/companies/${encodeURIComponent(slug)}/manifest.webmanifest`
}

/**
 * The head of a page for an identity. The visitor's pass links no manifest: there the public brand
 * and its files are all the page asks the server for. `pending`: the address names a company whose
 * identity is not known yet: the page is drawn in nobody's colours meanwhile (`PENDING_PALETTE`),
 * not in the default ones, which would be seen to change when the company's arrive.
 */
export function documentIdentityOf(identity: Identity, pathname: string, pending: boolean = false): DocumentIdentity {
  if (identity.kind === 'product') return { palette: null, themeColors: PLATFORM_THEME_COLORS, icons: 'product', manifest: PRODUCT_MANIFEST }
  if (identity.kind === 'neutral') {
    const palette = pending ? PENDING_PALETTE : null
    return { palette, themeColors: themeColors(palette), icons: 'neutral', manifest: null }
  }
  return {
    palette: identity.brand.palette,
    themeColors: themeColors(identity.brand.palette),
    icons: identity.brand.icon_url ? { url: identity.brand.icon_url } : 'neutral',
    manifest: identity.slug && areaOf(pathname) !== 'pass' ? companyManifestUrl(identity.slug) : null,
  }
}

interface IconLink {
  rel: 'icon' | 'apple-touch-icon'
  href: string
  sizes?: string
}

const ICON_SETS: Record<'product' | 'neutral', readonly IconLink[]> = {
  product: [
    { rel: 'icon', sizes: '16x16', href: '/icons/favicon-16.png' },
    { rel: 'icon', sizes: '32x32', href: '/icons/favicon-32.png' },
    { rel: 'icon', sizes: '48x48', href: '/icons/favicon-48.png' },
    { rel: 'icon', sizes: '192x192', href: '/icons/icon-192.png' },
    { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' },
  ],
  neutral: [
    { rel: 'icon', sizes: '16x16', href: '/icons/neutral-16.png' },
    { rel: 'icon', sizes: '32x32', href: '/icons/neutral-32.png' },
    { rel: 'icon', sizes: '48x48', href: '/icons/neutral-48.png' },
    { rel: 'icon', sizes: '192x192', href: '/icons/neutral-192.png' },
    { rel: 'apple-touch-icon', href: '/icons/neutral-apple-touch-icon.png' },
  ],
}

function iconLinks(icons: DocumentIdentity['icons']): readonly IconLink[] {
  if (typeof icons === 'string') return ICON_SETS[icons]
  return [
    { rel: 'icon', href: icons.url },
    { rel: 'apple-touch-icon', href: icons.url },
  ]
}

/** The tokens of the palette last applied: the same palette costs no second derivation. */
let derived: { signature: string; tokens: BrandTokens } | null = null

function tokensOf(palette: BrandPalette | null): BrandTokens | null {
  if (!palette) return null
  const signature = JSON.stringify(palette)
  if (derived?.signature !== signature) derived = { signature, tokens: brandTokens(palette) }
  return derived.tokens
}

/** The attribute the stylesheet keys on while a page's colours are replaced: no transition runs then (`index.css`). */
export const IDENTITY_CHANGE_ATTRIBUTE = 'data-identity-change'

/**
 * A page's colours are replaced at once, never faded: a button that turned from one company's
 * colour (or nobody's) to another's over 150 ms showed both. Transitions are off from now until the
 * new colours have been painted, two frames on. Also when the device's appearance changes the
 * colour scheme (Phase 13, `appearance/appearance.ts`).
 */
export function withoutTransitions(document: Document): void {
  const root = document.documentElement
  root.setAttribute(IDENTITY_CHANGE_ATTRIBUTE, '')
  const view = document.defaultView
  const clear = () => root.removeAttribute(IDENTITY_CHANGE_ATTRIBUTE)
  if (typeof view?.requestAnimationFrame === 'function') view.requestAnimationFrame(() => view.requestAnimationFrame(clear))
  else clear()
}

function setIcons(document: Document, icons: DocumentIdentity['icons']): void {
  const links = iconLinks(icons)
  const signature = links.map((link) => `${link.rel} ${link.sizes ?? ''} ${link.href}`).join('|')
  const root = document.documentElement
  if (root.dataset.identityIcons === signature) return
  for (const stale of document.head.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')) stale.remove()
  for (const link of links) {
    const element = document.createElement('link')
    element.rel = link.rel
    if (link.rel === 'icon') element.type = 'image/png'
    if (link.sizes) element.setAttribute('sizes', link.sizes)
    element.href = link.href
    document.head.append(element)
  }
  root.dataset.identityIcons = signature
}

function setManifest(document: Document, href: string | null): void {
  const existing = document.head.querySelector<HTMLLinkElement>('link[rel="manifest"]')
  if (href === null) {
    existing?.remove()
    return
  }
  if (existing?.getAttribute('href') === href) return
  // A new element: browsers read a manifest link when it is added, not when its address changes.
  existing?.remove()
  const element = document.createElement('link')
  element.rel = 'manifest'
  element.href = href
  document.head.append(element)
}

/**
 * The browser chrome's colour (`theme-color`) for the scheme the page is drawn in: the device's
 * choice of appearance, not the device's own scheme (Phase 13), so one meta without a `media` query.
 */
function setThemeColor(document: Document, colour: string): void {
  const metas = document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
  if (metas.length === 0) {
    const meta = document.createElement('meta')
    meta.name = 'theme-color'
    meta.content = colour
    document.head.append(meta)
  }
  for (const meta of metas) if (meta.content !== colour) meta.content = colour
}

/** Puts an identity on the document, for the colour scheme it is drawn in. Applying the same again changes nothing. */
export function applyDocumentIdentity(document: Document, identity: DocumentIdentity, scheme: 'light' | 'dark'): void {
  if (applyBrandVariables(document.documentElement.style, tokensOf(identity.palette))) withoutTransitions(document)
  setThemeColor(document, identity.themeColors[scheme])
  setIcons(document, identity.icons)
  setManifest(document, identity.manifest)
}

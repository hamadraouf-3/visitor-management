import type { PublicCompanyBrand } from '../types/api'
import { isCompanySlug, parsePublicBrand } from './brand'

/*
 * What this device keeps of companies' identities (Phase 12), in `localStorage`:
 *
 * - the company it last signed in to (`vms.company`, a slug), so `/login`, a sign-out and an expired
 *   session lead to that company's sign-in page;
 * - the last known identity of the few companies it has shown (`vms.brands`), so a page starts in
 *   its company's colours and logo instead of the default ones while the API answers.
 *
 * Both are display data only: a name, a colour, the addresses of the API's own brand files. Nothing
 * of a person, a session or a pass. Everything read is validated again (`parsePublicBrand`): storage
 * is shared with whatever ran in this origin before, and a palette that would not read is not used.
 */

export const COMPANY_STORAGE_KEY = 'vms.company'
export const BRANDS_STORAGE_KEY = 'vms.brands'

/** A device meets few companies; older ones are dropped. */
const MAX_BRANDS = 6

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** The company this device last signed in to, or null. */
export function readRememberedCompany(): string | null {
  try {
    const slug = storage()?.getItem(COMPANY_STORAGE_KEY)
    return isCompanySlug(slug) ? slug : null
  } catch {
    return null
  }
}

export function rememberCompany(slug: string): void {
  if (!isCompanySlug(slug)) return
  try {
    storage()?.setItem(COMPANY_STORAGE_KEY, slug)
  } catch {
    // Storage unavailable (private mode, quota): the device then simply does not remember.
  }
}

/** Forgets the device's company (it no longer exists, or was deactivated): `/login` is the neutral page again. */
export function forgetCompany(slug: string): void {
  try {
    if (storage()?.getItem(COMPANY_STORAGE_KEY) === slug) storage()?.removeItem(COMPANY_STORAGE_KEY)
  } catch {
    // Nothing was stored then.
  }
}

interface StoredBrand {
  /** When it was stored (ms): the oldest entries go first. */
  at: number
  brand: PublicCompanyBrand
}

function readBrands(): StoredBrand[] {
  try {
    const raw = storage()?.getItem(BRANDS_STORAGE_KEY)
    if (!raw || raw.length > 64_000) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const entries: StoredBrand[] = []
    for (const item of parsed.slice(0, MAX_BRANDS) as unknown[]) {
      if (!item || typeof item !== 'object') continue
      const { at, brand } = item as { at?: unknown; brand?: unknown }
      const valid = parsePublicBrand(brand)
      if (valid && typeof at === 'number' && Number.isFinite(at)) entries.push({ at, brand: valid })
    }
    return entries
  } catch {
    return []
  }
}

function writeBrands(entries: StoredBrand[]): void {
  try {
    storage()?.setItem(BRANDS_STORAGE_KEY, JSON.stringify(entries.toSorted((a, b) => b.at - a.at).slice(0, MAX_BRANDS)))
  } catch {
    // Storage unavailable: the next page load starts with the default identity until the API answers.
  }
}

/** The identity this device last saw for a company, validated; null when it has none. */
export function readCachedBrand(slug: string | null): PublicCompanyBrand | null {
  if (!slug) return null
  return readBrands().find((entry) => entry.brand.slug === slug)?.brand ?? null
}

/** What storage holds for a company, exactly as it is written there (not validated): only to tell whether a write would change it. */
function storedText(slug: string): string | null {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(BRANDS_STORAGE_KEY) ?? 'null')
    if (!Array.isArray(parsed)) return null
    const entries = (parsed as unknown[]).filter((item) => item && typeof item === 'object' && (item as { brand?: { slug?: unknown } }).brand?.slug === slug)
    // Two entries for one company are never written here: they are replaced by the one.
    return entries.length === 1 ? JSON.stringify((entries[0] as { brand: unknown }).brand) : null
  } catch {
    return null
  }
}

/**
 * Keeps a company's identity for the next page load: what the server answered replaces whatever
 * the device held for that company. Nothing is written only when storage already holds exactly
 * these words (compared as stored, not as read back: an entry that only reads the same after
 * validation, because part of it was refused, is written again).
 */
export function writeCachedBrand(brand: PublicCompanyBrand, now: number = Date.now()): void {
  const valid = parsePublicBrand(brand)
  if (!valid) return
  if (storedText(valid.slug) === JSON.stringify(valid)) return
  writeBrands([{ at: now, brand: valid }, ...readBrands().filter((entry) => entry.brand.slug !== valid.slug)])
}

export function dropCachedBrand(slug: string): void {
  const entries = readBrands()
  if (entries.some((entry) => entry.brand.slug === slug)) writeBrands(entries.filter((entry) => entry.brand.slug !== slug))
}

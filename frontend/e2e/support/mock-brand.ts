import { readFileSync } from 'node:fs'
import path from 'node:path'
import { makeBrand, referencePalette, SAMPLE_COLOURS } from '../../src/test/palettes.ts'
import type { BrandPalette, CompanyBrand, Me, PublicCompanyBrand } from '../../src/types/api.ts'
import { FRONTEND_DIR } from './paths.ts'

/*
 * A company's identity for the specs that mock the API (Phase 12). The backend alone derives a
 * palette: `mockPalette` answers the server's own one where the unit tests' fixture has the colour
 * (`src/test/serverPalettes.json`, written out from the backend's derivation), and the test suite's
 * stand-in (`src/test/palettes.ts`, which keeps the contract's guarantees for any colour) otherwise.
 * The scenarios (e2e/flows) use the real API.
 */

export { makeBrand, SAMPLE_COLOURS }

const SERVER_PALETTES = JSON.parse(readFileSync(path.join(FRONTEND_DIR, 'src', 'test', 'serverPalettes.json'), 'utf8')) as {
  roles: (keyof BrandPalette)[]
  palettes: Record<string, string[]>
}

/** The palette a mocked API answers for a colour (`#rrggbb`). */
export function mockPalette(colour: string): BrandPalette {
  const values = SERVER_PALETTES.palettes[colour]
  if (!values) return referencePalette(colour)
  return Object.fromEntries(SERVER_PALETTES.roles.map((role, index) => [role, values[index]])) as unknown as BrandPalette
}

/** A company without a logo and a colour: its name as a wordmark, the default palette. */
export const UNBRANDED: CompanyBrand = { logo_url: null, logo_dark_url: null, icon_url: null, color: null, palette: null, version: 'v0' }

/** The public brand of a mocked session's company, as GET /public/companies/{slug}/brand answers it. */
export function publicBrandOf(company: Me['company']): PublicCompanyBrand {
  return { slug: company.slug, name: company.name, name_ar: company.name_ar, default_language: company.default_language, brand: company.brand }
}

/** A 1 × 1 transparent PNG: what a mocked brand file answers when a spec does not care how the logo looks. */
export const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

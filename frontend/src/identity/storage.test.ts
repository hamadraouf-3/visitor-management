import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeBrand, SAMPLE_COLOURS } from '../test/palettes'
import type { PublicCompanyBrand } from '../types/api'
import { BRANDS_STORAGE_KEY, COMPANY_STORAGE_KEY, dropCachedBrand, forgetCompany, readCachedBrand, readRememberedCompany, rememberCompany, writeCachedBrand } from './storage'

/* What a device keeps of companies' identities (Phase 12): display data, validated every time it is read. */

function company(slug: string, colour: string = SAMPLE_COLOURS.teal): PublicCompanyBrand {
  return { slug, name: `Company ${slug}`, name_ar: null, default_language: 'en', brand: makeBrand(slug, { color: colour, logo: true }) }
}

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('the device’s company', () => {
  it('is remembered by its slug and read back', () => {
    expect(readRememberedCompany()).toBeNull()
    rememberCompany('nova-labs')
    expect(window.localStorage.getItem(COMPANY_STORAGE_KEY)).toBe('nova-labs')
    expect(readRememberedCompany()).toBe('nova-labs')
    rememberCompany('petra')
    expect(readRememberedCompany()).toBe('petra')
  })

  it('is nothing when what is stored is no slug', () => {
    for (const stored of ['', 'Nova Labs', '../admin', '<script>', 'x'.repeat(200)]) {
      window.localStorage.setItem(COMPANY_STORAGE_KEY, stored)
      expect(readRememberedCompany()).toBeNull()
    }
    rememberCompany('Not A Slug')
    expect(window.localStorage.getItem(COMPANY_STORAGE_KEY)).toBe('x'.repeat(200))
  })

  it('is forgotten only when it is the company named', () => {
    rememberCompany('nova-labs')
    forgetCompany('petra')
    expect(readRememberedCompany()).toBe('nova-labs')
    forgetCompany('nova-labs')
    expect(readRememberedCompany()).toBeNull()
  })

  it('costs nothing but the memory when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage is blocked')
    })
    expect(() => rememberCompany('nova-labs')).not.toThrow()
    expect(readRememberedCompany()).toBeNull()
    expect(readCachedBrand('nova-labs')).toBeNull()
    expect(() => writeCachedBrand(company('nova-labs'))).not.toThrow()
    expect(() => forgetCompany('nova-labs')).not.toThrow()
  })
})

describe('the identities a device has seen', () => {
  it('are kept per company and read back as they were', () => {
    const nova = company('nova-labs', SAMPLE_COLOURS.darkBlue)
    writeCachedBrand(nova, 1)
    writeCachedBrand(company('petra', SAMPLE_COLOURS.orange), 2)
    expect(readCachedBrand('nova-labs')).toEqual(nova)
    expect(readCachedBrand('petra')?.brand.color).toBe(SAMPLE_COLOURS.orange)
    expect(readCachedBrand('unknown')).toBeNull()
    expect(readCachedBrand(null)).toBeNull()
  })

  it('replace a company’s older copy, and write nothing when nothing changed', () => {
    writeCachedBrand(company('nova-labs', SAMPLE_COLOURS.darkBlue), 1)
    writeCachedBrand(company('nova-labs', SAMPLE_COLOURS.red), 2)
    expect(readCachedBrand('nova-labs')?.brand.color).toBe(SAMPLE_COLOURS.red)
    expect(JSON.parse(window.localStorage.getItem(BRANDS_STORAGE_KEY) ?? '[]')).toHaveLength(1)

    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    writeCachedBrand(company('nova-labs', SAMPLE_COLOURS.red), 3)
    expect(setItem).not.toHaveBeenCalled()
  })

  it('keep the six most recent companies', () => {
    for (let index = 1; index <= 8; index += 1) writeCachedBrand(company(`company-${index}`), index)
    const stored = JSON.parse(window.localStorage.getItem(BRANDS_STORAGE_KEY) ?? '[]') as { brand: { slug: string } }[]
    expect(stored.map((entry) => entry.brand.slug)).toEqual(['company-8', 'company-7', 'company-6', 'company-5', 'company-4', 'company-3'])
    expect(readCachedBrand('company-1')).toBeNull()
  })

  it('are dropped by slug', () => {
    writeCachedBrand(company('nova-labs'), 1)
    writeCachedBrand(company('petra'), 2)
    dropCachedBrand('nova-labs')
    expect(readCachedBrand('nova-labs')).toBeNull()
    expect(readCachedBrand('petra')).not.toBeNull()
  })

  it('never lend one company another company’s files: a stored copy keeps only its own company’s addresses (security review, Phase 12)', () => {
    const demo = company('demo-company')
    // What the review planted: an entry for `evil-co` whose logo is demo-company's.
    const planted = { slug: 'evil-co', name: 'Evil Co', name_ar: null, default_language: 'en', brand: { ...makeBrand('evil-co', { icon: true }), logo_url: '/api/v1/public/companies/demo-company/brand/logo.png?v=zzz' } }
    window.localStorage.setItem(BRANDS_STORAGE_KEY, JSON.stringify([{ at: 9, brand: planted }, { at: 1, brand: demo }]))
    const read = readCachedBrand('evil-co')
    expect(read?.brand.logo_url).toBeNull()
    // Its own icon stays, and the other company's copy is untouched.
    expect(read?.brand.icon_url).toBe('/api/v1/public/companies/evil-co/brand/icon.png?v=v1')
    expect(readCachedBrand('demo-company')).toEqual(demo)
  })

  it('are replaced by the server’s answer, also when the stored words only read the same after validation', () => {
    // The server's answer for the company: no logo. The planted copy reads the same once its foreign logo is refused.
    const answer: PublicCompanyBrand = { slug: 'evil-co', name: 'Evil Co', name_ar: null, default_language: 'en', brand: makeBrand('evil-co') }
    const planted = { ...answer, brand: { ...answer.brand, logo_url: '/api/v1/public/companies/demo-company/brand/logo.png?v=zzz' } }
    window.localStorage.setItem(BRANDS_STORAGE_KEY, JSON.stringify([{ at: 9, brand: planted }]))
    expect(readCachedBrand('evil-co')).toEqual(answer)
    writeCachedBrand(answer, 20)
    const stored = window.localStorage.getItem(BRANDS_STORAGE_KEY) ?? ''
    expect(stored).not.toContain('demo-company')
    expect(JSON.parse(stored)).toEqual([{ at: 20, brand: answer }])
    // Two entries for one company (never written here) become the one the server answered.
    window.localStorage.setItem(BRANDS_STORAGE_KEY, JSON.stringify([{ at: 30, brand: answer }, { at: 31, brand: { ...answer, name: 'Somebody Else' } }]))
    writeCachedBrand(answer, 40)
    expect(JSON.parse(window.localStorage.getItem(BRANDS_STORAGE_KEY) ?? '')).toEqual([{ at: 40, brand: answer }])
    // The same words again: nothing is written.
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    writeCachedBrand(answer, 50)
    expect(setItem).not.toHaveBeenCalled()
  })

  it('are validated when read: what would not read, or is not the API’s, is not used', () => {
    const nova = company('nova-labs', SAMPLE_COLOURS.darkBlue)
    const tampered = {
      ...nova,
      name: 'Nova Labs',
      brand: {
        ...nova.brand,
        logo_url: 'https://evil.example/pixel.png',
        // White text on white: a palette nobody could read.
        palette: { ...nova.brand.palette, strong: '#ffffff' },
      },
    }
    window.localStorage.setItem(BRANDS_STORAGE_KEY, JSON.stringify([{ at: 1, brand: tampered }]))
    expect(readCachedBrand('nova-labs')).toEqual({ ...nova, name: 'Nova Labs', brand: { ...nova.brand, logo_url: null, color: null, palette: null } })
  })

  it.each([
    ['not JSON', '{'],
    ['not a list', '{"nova-labs":{}}'],
    ['a list of other things', '[1,"x",null,{"at":"now","brand":{}}]'],
    ['a company without a name', JSON.stringify([{ at: 1, brand: { slug: 'nova-labs', name: '' } }])],
    ['far too long', `[${'1,'.repeat(40_000)}1]`],
  ])('are nothing when what is stored is %s', (_what, stored) => {
    window.localStorage.setItem(BRANDS_STORAGE_KEY, stored)
    expect(readCachedBrand('nova-labs')).toBeNull()
    // Writing starts again from a clean list.
    writeCachedBrand(company('nova-labs'), 5)
    expect(readCachedBrand('nova-labs')).not.toBeNull()
  })

  it('never hold anything of a person or a session', () => {
    writeCachedBrand({ ...company('nova-labs'), user: { email: 'lina@example.com' }, token: 'secret' } as PublicCompanyBrand, 1)
    const stored = window.localStorage.getItem(BRANDS_STORAGE_KEY) ?? ''
    expect(stored).not.toContain('lina@example.com')
    expect(stored).not.toContain('secret')
    expect(Object.keys((JSON.parse(stored) as { brand: object }[])[0]!.brand).toSorted()).toEqual(['brand', 'default_language', 'name', 'name_ar', 'slug'])
  })
})

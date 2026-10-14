import { describe, expect, it } from 'vitest'
import { makeMe } from '../test/api'
import { makeBrand, SAMPLE_COLOURS } from '../test/palettes'
import type { Me, PublicCompanyBrand } from '../types/api'
import { EMPTY_BRAND } from './brand'
import { areaOf, identityName, identityOfPublicBrand, identityOfSession, needsPublicBrand, NEUTRAL, PRODUCT, resolveIdentity, type IdentityInputs } from './identity'
import { companySlugOf, isCompanySignInPage, signInPathFor, withCompany } from './links'

/* Whose identity a page shows, in every state (Phase 12). */

const NOVA: PublicCompanyBrand = { slug: 'nova-labs', name: 'Nova Labs', name_ar: 'مختبرات نوفا', default_language: 'ar', brand: makeBrand('nova-labs', { color: SAMPLE_COLOURS.darkBlue, logo: true }) }
const PETRA: PublicCompanyBrand = { slug: 'petra', name: 'Petra Logistics', name_ar: null, default_language: 'en', brand: makeBrand('petra', { color: SAMPLE_COLOURS.orange }) }

function me(company: Partial<Me['company']> = {}): Me {
  const session = makeMe(['EMPLOYEE'])
  return { ...session, company: { ...session.company, ...company } }
}

const resolve = (inputs: Partial<IdentityInputs>) => resolveIdentity({ pathname: '/visits', search: '', me: undefined, publicBrand: undefined, remembered: null, ...inputs })

describe('where an address lies', () => {
  it.each([
    ['/platform', 'platform'],
    ['/platform/login', 'platform'],
    ['/platform/companies/9b/identity', 'platform'],
    ['/pass', 'pass'],
    ['/login', 'public'],
    ['/forgot-password', 'public'],
    ['/reset-password', 'public'],
    ['/c/nova-labs', 'public'],
    ['/c/nova-labs/login', 'public'],
    ['/c/nova-labs/', 'public'],
    ['/', 'app'],
    ['/visits', 'app'],
    ['/reception', 'app'],
    ['/change-password', 'app'],
    ['/platformx', 'app'],
    ['/c/nova-labs/visits', 'app'],
    ['/no-such-page', 'app'],
  ] as const)('%s is %s', (pathname, area) => {
    expect(areaOf(pathname)).toBe(area)
  })
})

describe('the company an address names', () => {
  it('is the slug of a company’s sign-in page, or of ?c=', () => {
    expect(companySlugOf({ pathname: '/c/nova-labs', search: '' })).toBe('nova-labs')
    expect(companySlugOf({ pathname: '/c/nova-labs/login', search: '?next=%2Fvisits' })).toBe('nova-labs')
    expect(companySlugOf({ pathname: '/login', search: '?c=petra' })).toBe('petra')
    expect(companySlugOf({ pathname: '/pass', search: '?c=petra' })).toBe('petra')
    expect(companySlugOf({ pathname: '/reset-password', search: '?next=x&c=nova-labs' })).toBe('nova-labs')
    // The path's own company wins over a parameter.
    expect(companySlugOf({ pathname: '/c/nova-labs', search: '?c=petra' })).toBe('nova-labs')
  })

  it('is none when the address names no company, or what it names is no slug', () => {
    for (const location of [
      { pathname: '/login', search: '' },
      { pathname: '/login', search: '?c=' },
      { pathname: '/login', search: '?c=Nova Labs' },
      { pathname: '/login', search: '?c=../admin' },
      { pathname: '/c/Nova%20Labs', search: '' },
      { pathname: '/c/%E0%A4%A', search: '' },
      { pathname: '/c/-nova', search: '' },
    ]) {
      expect(companySlugOf(location)).toBeNull()
    }
    expect(isCompanySignInPage('/c/anything-at-all')).toBe(true)
    expect(isCompanySignInPage('/c/nova-labs/visits')).toBe(false)
  })

  it('is kept across the links between the signed-out pages', () => {
    expect(withCompany('/forgot-password', 'nova-labs')).toBe('/forgot-password?c=nova-labs')
    expect(withCompany('/forgot-password', null)).toBe('/forgot-password')
    expect(withCompany('/pass', 'petra')).toBe('/pass?c=petra')
    // The company comes first and is never repeated; the path's own parameters stay.
    expect(withCompany('/login?next=%2Fvisits&c=old', 'nova-labs')).toBe('/login?c=nova-labs&next=%2Fvisits')
    expect(signInPathFor('nova-labs')).toBe('/c/nova-labs')
    expect(signInPathFor(null)).toBe('/login')
  })
})

describe('the identity of a page', () => {
  it('is the product’s in the platform owner’s area, whoever is signed in to a company', () => {
    for (const pathname of ['/platform', '/platform/login', '/platform/companies', '/platform/companies/9b/identity']) {
      expect(resolve({ pathname, me: me({ brand: NOVA.brand }), remembered: NOVA })).toEqual({ identity: PRODUCT, pending: false, linkSlug: null })
    }
    // A parameter does not make a platform page a company's.
    expect(resolve({ pathname: '/platform/login', search: '?c=nova-labs', publicBrand: NOVA }).identity).toBe(PRODUCT)
  })

  it('is the session’s company once signed in', () => {
    const session = me({ slug: 'nova-labs', name: 'Nova Labs', name_ar: 'مختبرات نوفا', brand: NOVA.brand })
    const { identity, pending } = resolve({ pathname: '/visits', me: session })
    expect(pending).toBe(false)
    expect(identity).toEqual({ kind: 'company', slug: 'nova-labs', name: 'Nova Labs', nameAr: 'مختبرات نوفا', brand: NOVA.brand })
    // Also on a page used signed out, and whatever company its address names.
    expect(resolve({ pathname: '/c/petra', me: session, publicBrand: PETRA }).identity).toEqual(identity)
    expect(resolve({ pathname: '/login', me: session }).identity).toEqual(identity)
  })

  it('is a company without a brand for a session that carries none: its name, the default palette', () => {
    const session = makeMe(['EMPLOYEE'])
    const company = session.company as Partial<Me['company']>
    delete company.brand
    delete company.slug
    expect(identityOfSession(session)).toEqual({ kind: 'company', slug: null, name: 'Acme Holdings', nameAr: null, brand: EMPTY_BRAND })
  })

  it('is the company an address names, signed out: on its sign-in page, or with ?c=', () => {
    for (const [pathname, search] of [
      ['/c/nova-labs', ''],
      ['/c/nova-labs/login', ''],
      ['/login', '?c=nova-labs'],
      ['/forgot-password', '?c=nova-labs'],
      ['/reset-password', '?c=nova-labs'],
    ] as const) {
      for (const session of [null, undefined]) {
        expect(resolve({ pathname, search, me: session, publicBrand: NOVA })).toEqual({ identity: identityOfPublicBrand(NOVA), pending: false, linkSlug: 'nova-labs' })
      }
    }
  })

  it('is neutral for a slug nobody has, and says nothing of whether the company exists', () => {
    expect(resolve({ pathname: '/c/no-such-company', me: null, publicBrand: null })).toEqual({ identity: NEUTRAL, pending: false, linkSlug: 'no-such-company' })
    // Exactly what `/login` shows.
    expect(resolve({ pathname: '/login', me: null }).identity).toBe(NEUTRAL)
  })

  it('draws nothing of an identity while the company an address names is not known yet', () => {
    expect(resolve({ pathname: '/c/nova-labs', me: null, publicBrand: undefined })).toEqual({ identity: NEUTRAL, pending: true, linkSlug: 'nova-labs' })
    expect(resolve({ pathname: '/pass', search: '?c=nova-labs', publicBrand: undefined }).pending).toBe(true)
  })

  it('is the company its link names on the visitor’s pass, and never the session’s', () => {
    const session = me({ slug: 'petra', name: 'Petra Logistics', brand: PETRA.brand })
    expect(resolve({ pathname: '/pass', search: '?c=nova-labs', me: session, publicBrand: NOVA, remembered: PETRA }).identity).toEqual(identityOfPublicBrand(NOVA))
    // An older link without a company: the neutral pass, also on a device that is signed in or remembers a company.
    expect(resolve({ pathname: '/pass', me: session, remembered: PETRA })).toEqual({ identity: NEUTRAL, pending: false, linkSlug: null })
    expect(resolve({ pathname: '/pass', search: '?c=gone', me: session, publicBrand: null }).identity).toBe(NEUTRAL)
  })

  it('is neutral without a session and without a company in the address', () => {
    for (const pathname of ['/login', '/forgot-password', '/reset-password', '/no-such-page', '/visits']) {
      expect(resolve({ pathname, me: null, remembered: NOVA })).toEqual({ identity: NEUTRAL, pending: false, linkSlug: null })
    }
  })

  it('starts a page of the app in the device’s own company while the session is not known yet', () => {
    expect(resolve({ pathname: '/visits', me: undefined, remembered: NOVA }).identity).toEqual(identityOfPublicBrand(NOVA))
    expect(resolve({ pathname: '/no-such-page', me: undefined, remembered: NOVA }).identity).toEqual(identityOfPublicBrand(NOVA))
    // Not the pages used signed out: `/login` is the neutral page until it leads to the company's own.
    expect(resolve({ pathname: '/login', me: undefined, remembered: NOVA }).identity).toBe(NEUTRAL)
    expect(resolve({ pathname: '/visits', me: undefined, remembered: null }).identity).toBe(NEUTRAL)
  })

  it('names a company in the UI language: its Arabic name in Arabic when it has one', () => {
    expect(identityName(identityOfPublicBrand(NOVA), 'ar')).toBe('مختبرات نوفا')
    expect(identityName(identityOfPublicBrand(NOVA), 'en')).toBe('Nova Labs')
    expect(identityName(identityOfPublicBrand(PETRA), 'ar')).toBe('Petra Logistics')
  })
})

describe('when the public brand endpoint is asked', () => {
  it('only for a company an address names, while nobody is signed in', () => {
    expect(needsPublicBrand({ pathname: '/c/nova-labs', search: '', me: null })).toBe('nova-labs')
    expect(needsPublicBrand({ pathname: '/login', search: '?c=petra', me: undefined })).toBe('petra')
    expect(needsPublicBrand({ pathname: '/c/nova-labs', search: '', me: me() })).toBeNull()
    expect(needsPublicBrand({ pathname: '/login', search: '', me: null })).toBeNull()
    expect(needsPublicBrand({ pathname: '/visits', search: '', me: undefined })).toBeNull()
    expect(needsPublicBrand({ pathname: '/platform/login', search: '?c=nova-labs', me: null })).toBeNull()
  })

  it('always on the visitor’s pass with a company, signed in or not', () => {
    expect(needsPublicBrand({ pathname: '/pass', search: '?c=nova-labs', me: me() })).toBe('nova-labs')
    expect(needsPublicBrand({ pathname: '/pass', search: '?c=nova-labs', me: null })).toBe('nova-labs')
    expect(needsPublicBrand({ pathname: '/pass', search: '', me: null })).toBeNull()
  })
})

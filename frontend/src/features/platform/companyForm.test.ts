import { describe, expect, it } from 'vitest'
import {
  EMPTY_NEW_COMPANY,
  isValidSlug,
  suggestSlug,
  toAdminCreate,
  toCompanyCreate,
  toCompanyUpdate,
  validateAdminValues,
  validateNewCompany,
  withName,
  companyIdentityValues,
} from './companyForm'
import { safePlatformNextPath, platformLoginPath, postPlatformLoginPath } from './platformRedirect'
import { makePlatformCompany, makePlatformMe } from './testRoutes'

const VALID = {
  ...EMPTY_NEW_COMPANY,
  name: ' Nova Labs ',
  nameAr: '',
  slug: 'nova-labs',
  adminFullName: ' Nadia Haddad ',
  adminEmail: ' Nadia@Nova.Example ',
  adminPassword: 'k7Hq2-mPx9z-4tRwc-Yb3nD',
}

describe('the suggested slug', () => {
  it('comes from the English name: lower case, accents dropped, hyphens between words', () => {
    expect(suggestSlug('Nova Labs, Inc.')).toBe('nova-labs-inc')
    expect(suggestSlug('  Café Délice  ')).toBe('cafe-delice')
    expect(suggestSlug('ACME--Holdings 2026')).toBe('acme-holdings-2026')
  })

  it('is empty for a name without Latin letters or digits, and at most 80 characters without a hyphen at the end', () => {
    expect(suggestSlug('موضوع')).toBe('')
    const long = suggestSlug(`${'a'.repeat(79)} b`)
    expect(long.length).toBeLessThanOrEqual(80)
    expect(long.endsWith('-')).toBe(false)
  })

  it('follows the name until the slug is typed', () => {
    let values = withName(EMPTY_NEW_COMPANY, 'Nova')
    expect(values.slug).toBe('nova')
    values = { ...values, slug: 'my-slug', slugEdited: true }
    expect(withName(values, 'Nova Labs').slug).toBe('my-slug')
  })

  it('is checked as the server checks it', () => {
    for (const slug of ['a', 'nova-labs', 'a1', 'a--b', 'x'.repeat(80)]) expect(isValidSlug(slug)).toBe(true)
    for (const slug of ['', '-a', 'a-', 'Nova', 'nova labs', 'x'.repeat(81), 'nová']) expect(isValidSlug(slug)).toBe(false)
  })
})

describe('a new company', () => {
  it('needs a name, a slug, a time zone and its first administrator', () => {
    const errors = validateNewCompany({ ...EMPTY_NEW_COMPANY, timezone: '' })
    expect(errors.name).toBe('Enter the company name.')
    expect(errors.slug).toBe('Enter a slug.')
    expect(errors.timezone).toBe('Choose a time zone.')
    expect(errors.adminFullName).toBe("Enter the administrator's full name.")
    expect(errors.adminEmail).toBe("Enter the administrator's email address.")
    expect(errors.adminPassword).toBeTruthy()
  })

  it('refuses a malformed slug and address and a password equal to the address', () => {
    const errors = validateNewCompany({ ...VALID, slug: 'Nova Labs', adminEmail: 'nadia', adminPassword: 'nadia@nova.example' })
    expect(errors.slug).toBe('Use lowercase letters, digits and hyphens, with no hyphen at either end.')
    expect(errors.adminEmail).toMatch(/valid email/)
    expect(validateNewCompany({ ...VALID, adminPassword: 'Nadia@Nova.Example1' }).adminPassword).toBeUndefined()
  })

  it('is sent trimmed, without an empty Arabic name, the address in lower case', () => {
    expect(validateNewCompany(VALID)).toEqual({})
    expect(toCompanyCreate(VALID)).toEqual({
      name: 'Nova Labs',
      slug: 'nova-labs',
      timezone: 'Asia/Amman',
      default_language: 'ar',
      admin: { full_name: 'Nadia Haddad', email: 'nadia@nova.example', temporary_password: 'k7Hq2-mPx9z-4tRwc-Yb3nD' },
    })
    expect(toCompanyCreate({ ...VALID, nameAr: ' نوفا ' }).name_ar).toBe('نوفا')
  })
})

describe('editing a company', () => {
  it('sends only what changed, a cleared Arabic name as null, or nothing', () => {
    const company = makePlatformCompany()
    const values = companyIdentityValues(company)
    expect(toCompanyUpdate(company, values)).toBeNull()
    expect(toCompanyUpdate(company, { ...values, name: ' Nova Labs ' })).toBeNull()
    expect(toCompanyUpdate(company, { ...values, nameAr: '' })).toEqual({ name_ar: null })
    expect(toCompanyUpdate(company, { ...values, timezone: 'Europe/London', defaultLanguage: 'ar' })).toEqual({ timezone: 'Europe/London', default_language: 'ar' })
  })
})

describe('another administrator', () => {
  it('is checked and sent like the first', () => {
    expect(validateAdminValues({ fullName: '', email: '', temporaryPassword: '' })).toMatchObject({ fullName: expect.any(String), email: expect.any(String), temporaryPassword: expect.any(String) })
    expect(toAdminCreate({ fullName: ' Rami ', email: ' Rami@X.Example ', temporaryPassword: 'p' })).toEqual({ full_name: 'Rami', email: 'rami@x.example', temporary_password: 'p' })
  })
})

describe('the platform sign-in’s destinations', () => {
  const origin = 'http://localhost'

  it('accepts platform pages only, never the sign-in itself, another origin or a company page', () => {
    expect(safePlatformNextPath('/platform/companies/abc?x=1', origin)).toBe('/platform/companies/abc?x=1')
    expect(safePlatformNextPath('/platform/audit', origin)).toBe('/platform/audit')
    expect(safePlatformNextPath('/platform/login', origin)).toBeNull()
    expect(safePlatformNextPath('/admin', origin)).toBeNull()
    expect(safePlatformNextPath('//evil.example/platform', origin)).toBeNull()
    expect(safePlatformNextPath('/platform/../admin', origin)).toBeNull()
    expect(safePlatformNextPath('https://evil.example/platform', origin)).toBeNull()
    // The search text is never put in an address (PRIVATE_PARAMS).
    expect(safePlatformNextPath('/platform/companies?q=nova&status=active', origin)).toBe('/platform/companies?status=active')
  })

  it('goes to the forced change first, then `next`, then the companies', () => {
    expect(postPlatformLoginPath(makePlatformMe({ must_change_password: true }), '/platform/audit')).toBe('/platform/change-password')
    expect(postPlatformLoginPath(makePlatformMe(), '/platform/audit')).toBe('/platform/audit')
    expect(postPlatformLoginPath(makePlatformMe(), null)).toBe('/platform/companies')
  })

  it('carries the page in `next`, but not the companies (the default)', () => {
    expect(platformLoginPath({ pathname: '/platform/audit', search: '?company=1' })).toBe('/platform/login?next=%2Fplatform%2Faudit%3Fcompany%3D1')
    expect(platformLoginPath({ pathname: '/platform/companies', search: '' })).toBe('/platform/login')
    expect(platformLoginPath({ pathname: '/platform', search: '' })).toBe('/platform/login')
  })
})

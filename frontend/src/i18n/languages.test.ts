import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeMe } from '../test/api'
import { browserLanguage, deviceLanguage, directionOf, LANGUAGE_STORAGE_KEY, readStoredLanguage, storeLanguage } from './languages'
import { companyDisplayName, sessionLanguage } from './session'

afterEach(() => {
  window.localStorage.removeItem(LANGUAGE_STORAGE_KEY)
})

describe('the language before sign-in', () => {
  it('takes the first of the browser languages the app speaks', () => {
    expect(browserLanguage(['ar-JO', 'en-US'])).toBe('ar')
    expect(browserLanguage(['fr-FR', 'en-GB', 'ar'])).toBe('en')
    expect(browserLanguage(['AR'])).toBe('ar')
    expect(browserLanguage(['fr-FR', 'de'])).toBeNull()
    expect(browserLanguage([])).toBeNull()
  })

  it('prefers the language this device used last, then the browser, then Arabic', () => {
    // jsdom's browser language is en-US.
    expect(deviceLanguage()).toBe('en')
    storeLanguage('ar')
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('ar')
    expect(deviceLanguage()).toBe('ar')

    window.localStorage.removeItem(LANGUAGE_STORAGE_KEY)
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['fr-FR'])
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('fr-FR')
    expect(deviceLanguage()).toBe('ar')
  })

  it('ignores a stored value that is not a language, and storage that throws', () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'fr')
    expect(readStoredLanguage()).toBeNull()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    expect(readStoredLanguage()).toBeNull()
    expect(() => storeLanguage('ar')).not.toThrow()
  })

  it('writes Arabic right to left', () => {
    expect(directionOf('ar')).toBe('rtl')
    expect(directionOf('en')).toBe('ltr')
  })
})

describe('the signed-in language', () => {
  it("is the user's preference, else the company's default", () => {
    const me = makeMe(['EMPLOYEE'])
    expect(sessionLanguage({ ...me, company: { ...me.company, default_language: 'ar' } })).toBe('ar')
    expect(sessionLanguage({ ...me, user: { ...me.user, preferred_language: 'en' }, company: { ...me.company, default_language: 'ar' } })).toBe('en')
    expect(sessionLanguage({ ...me, user: { ...me.user, preferred_language: 'ar' } })).toBe('ar')
  })

  it('is unknown against an API that does not send the language fields (the device language stays)', () => {
    const me = makeMe(['EMPLOYEE'])
    const { preferred_language: _preference, ...user } = me.user
    const { default_language: _default, name_ar: _nameAr, ...company } = me.company
    expect(sessionLanguage({ user, company } as unknown as typeof me)).toBeNull()
  })

  it('names the company in Arabic in the Arabic UI when it has an Arabic name', () => {
    const company = { ...makeMe().company, name: 'Mawdoo3', name_ar: 'موضوع' }
    expect(companyDisplayName(company, 'ar')).toBe('موضوع')
    expect(companyDisplayName(company, 'en')).toBe('Mawdoo3')
    expect(companyDisplayName({ ...company, name_ar: null }, 'ar')).toBe('Mawdoo3')
    expect(companyDisplayName({ ...company, name_ar: '  ' }, 'ar')).toBe('Mawdoo3')
  })
})

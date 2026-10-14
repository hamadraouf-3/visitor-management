import type { Me } from '../types/api'
import { isLanguage, type Language } from './languages'

/*
 * The language fields of `Me` (phase 10 contract): `user.preferred_language`, `company.name_ar`
 * and `company.default_language`. Every value is checked at run time: an API from before phase 10
 * (or a mocked `Me`) leaves them out, and the device's language then stays.
 */

/** The user's own choice, or null when they have not made one. */
export function preferredLanguageOf(me: Me): Language | null {
  const value: unknown = me.user.preferred_language
  return isLanguage(value) ? value : null
}

/** The company's default language, or null when the API does not say. */
export function companyDefaultLanguageOf(me: Me): Language | null {
  const value: unknown = me.company.default_language
  return isLanguage(value) ? value : null
}

/** The signed-in user's language: their preference, else their company's default (null: neither is known). */
export function sessionLanguage(me: Me): Language | null {
  return preferredLanguageOf(me) ?? companyDefaultLanguageOf(me)
}

/** What a company's displayed name is made of (the session's company, a company of the platform owner's lists). */
export type NamedCompany = Pick<Me['company'], 'name' | 'name_ar'>

/** The company's name as shown: the Arabic name in the Arabic UI when it has one. */
export function companyDisplayName(company: NamedCompany, language: Language): string {
  const nameAr: unknown = company.name_ar
  if (language === 'ar' && typeof nameAr === 'string' && nameAr.trim() !== '') return nameAr
  return company.name
}

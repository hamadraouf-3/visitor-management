/**
 * The UI languages and the rules that pick one (phase 10, F10-3).
 *
 * - Signed in: the user's `preferred_language`, else the company's `default_language`.
 * - Before sign-in (and against an API that does not send those fields yet): the language this
 *   device last used (`localStorage`), else the first of the browser's languages that the app
 *   speaks, else Arabic, the product's default.
 *
 * Arabic is written right to left: `<html dir="rtl">`, and the layout mirrors through logical
 * properties (`ms-`/`me-`/`ps-`/`pe-`/`start-`/`end-`, `text-start`).
 */
export const LANGUAGES = ['ar', 'en'] as const

export type Language = (typeof LANGUAGES)[number]

/** The product's default (the demo company's language). */
export const DEFAULT_LANGUAGE: Language = 'ar'

export type Direction = 'rtl' | 'ltr'

/**
 * How each language names itself: the language switcher offers the *other* language under its
 * own name and in its own script, so whoever reads it finds their language whatever the UI shows.
 * `short` is the visible label ("ع", "EN"); the accessible name (`name`) contains it.
 */
export const LANGUAGE_NAMES: Record<Language, { name: string; short: string }> = {
  ar: { name: 'العربية', short: 'ع' },
  en: { name: 'English', short: 'EN' },
}

/**
 * Locales for `Intl`. Arabic uses the Levantine month names used across Jordan ("تشرين الأول",
 * `ar-JO`) and Latin digits (`-u-nu-latn`), so times, codes, counts and phone numbers read the
 * same in both languages and match what people type (F10-5).
 */
export const INTL_LOCALES: Record<Language, string> = {
  ar: 'ar-JO-u-nu-latn',
  en: 'en-GB',
}

/** Key of the device's language in `localStorage`. */
export const LANGUAGE_STORAGE_KEY = 'vms.language'

export function isLanguage(value: unknown): value is Language {
  return value === 'ar' || value === 'en'
}

export function directionOf(language: Language): Direction {
  return language === 'ar' ? 'rtl' : 'ltr'
}

/** The language this device last used, or null (none stored, or storage is unavailable). */
export function readStoredLanguage(): Language | null {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
    return isLanguage(stored) ? stored : null
  } catch {
    return null
  }
}

/** Remembers the language on this device (private browsing may refuse; that only costs the memory). */
export function storeLanguage(language: Language): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    // Storage unavailable (private mode, quota): the language still applies to this page.
  }
}

/**
 * Key (in `sessionStorage`: this tab, this visit) of the flag that says someone picked the stored
 * language with the switch while signed out (the sign-in page), rather than inheriting it.
 */
export const LANGUAGE_CHOSEN_KEY = 'vms.language.chosen'

/** Notes that the language now stored was picked on purpose before sign-in (see `takeChosenLanguage`). */
export function markLanguageChosen(): void {
  try {
    window.sessionStorage.setItem(LANGUAGE_CHOSEN_KEY, '1')
  } catch {
    // Storage unavailable: the choice then only lasts until sign-in, as before.
  }
}

/**
 * The language someone picked with the switch before signing in, during this visit, or null; the
 * note is used up. At sign-in an account without a preference of its own keeps (and saves) that
 * choice instead of switching to the company's default.
 */
export function takeChosenLanguage(): Language | null {
  try {
    if (window.sessionStorage.getItem(LANGUAGE_CHOSEN_KEY) === null) return null
    window.sessionStorage.removeItem(LANGUAGE_CHOSEN_KEY)
  } catch {
    return null
  }
  return readStoredLanguage()
}

/** The first of the browser's preferred languages that the app speaks ("ar-JO" → ar, "en-US" → en). */
export function browserLanguage(languages: readonly string[] = browserLanguageList()): Language | null {
  for (const tag of languages) {
    const primary = tag.toLowerCase().split('-')[0]
    if (isLanguage(primary)) return primary
  }
  return null
}

function browserLanguageList(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : []
}

/** The language before anyone signs in: stored choice, then the browser's, then the default. */
export function deviceLanguage(): Language {
  return readStoredLanguage() ?? browserLanguage() ?? DEFAULT_LANGUAGE
}

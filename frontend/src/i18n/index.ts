import { createInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import { deviceLanguage, directionOf, isLanguage, LANGUAGES, storeLanguage, type Language } from './languages'
import { NAMESPACES, resources } from './resources'

export {
  DEFAULT_LANGUAGE,
  directionOf,
  INTL_LOCALES,
  isLanguage,
  LANGUAGE_NAMES,
  LANGUAGE_STORAGE_KEY,
  LANGUAGES,
  type Direction,
  type Language,
} from './languages'
export { NAMESPACES, type Namespace } from './resources'

/**
 * The app's i18next instance (F10-1). Initialised synchronously with every catalog, in the
 * language this device used last (or the browser's, or Arabic): the first render is already in
 * that language. `LanguageController` switches to the signed-in user's language when the session
 * is known. Components read texts with `useTranslation()`; plain functions (formatters, the API
 * client's error messages) with `i18n.t`, and they follow `currentLanguage()`.
 */
export const i18n = createInstance()

void i18n.use(initReactI18next).init({
  resources,
  lng: typeof window === 'undefined' ? 'en' : deviceLanguage(),
  // A key the Arabic catalog lacks (catalogs.test.ts forbids it) would show the English text
  // rather than the key.
  fallbackLng: 'en',
  supportedLngs: LANGUAGES,
  ns: NAMESPACES,
  defaultNS: 'common',
  interpolation: {
    // React escapes everything it renders.
    escapeValue: false,
  },
  returnNull: false,
  initAsync: false,
  react: { useSuspense: false },
})

/** The language the UI shows now. */
export function currentLanguage(): Language {
  const language = i18n.resolvedLanguage ?? i18n.language
  return isLanguage(language) ? language : 'en'
}

/** `<html lang dir>` follow the UI language: screen readers, hyphenation, the mirrored layout. */
function applyToDocument(language: Language): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.lang = language
  root.dir = directionOf(language)
}

i18n.on('languageChanged', (language) => {
  if (isLanguage(language)) applyToDocument(language)
})
applyToDocument(currentLanguage())

/**
 * Shows the UI in `language` now and remembers it on this device, so the next page load (and the
 * sign-in page) starts in it. Saving it to the account is `useChangeLanguage`'s job.
 */
export function applyLanguage(language: Language): void {
  storeLanguage(language)
  if (currentLanguage() !== language) void i18n.changeLanguage(language)
}

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { updatePreferences } from '../api/auth'
import { productName } from '../brand'
import { getErrorMessage } from '../api/client'
import { queryKeys } from '../api/queryKeys'
import { useCachedMe } from '../auth/useAuth'
import { useToast } from '../components/ui/toastContext'
import type { Me } from '../types/api'
import { applyLanguage, currentLanguage, i18n } from './index'
import { directionOf, isLanguage, markLanguageChosen, takeChosenLanguage, type Direction, type Language } from './languages'
import { companyDisplayName, preferredLanguageOf, sessionLanguage, type NamedCompany } from './session'

/**
 * The UI language and writing direction. Calling it also re-renders the component when the
 * language changes (as `useTranslation()` does), e.g. for code that only formats dates.
 */
export function useLanguage(): { language: Language; direction: Direction } {
  const { i18n: instance } = useTranslation()
  const resolved = instance.resolvedLanguage
  const language: Language = isLanguage(resolved) ? resolved : 'en'
  return { language, direction: directionOf(language) }
}

/**
 * The company's name as the UI shows it (phase 10 contract): its Arabic name (`name_ar`) in the
 * Arabic UI when it has one, else `name`. Re-renders on a language switch. Every screen that
 * names the company (headers, printed pages, the printed pass) takes the name from here, never
 * from `company.name` directly. An empty string while there is no session yet.
 */
export function useCompanyName(company: NamedCompany | null | undefined): string {
  const { language } = useLanguage()
  return company ? companyDisplayName(company, language) : ''
}

/**
 * The product's name in the UI language («زوار موضوع», "Mawdoo3 Visitors"), re-rendering on a
 * language switch. Only the platform owner's area names the product (Phase 12): its lockup is
 * `BrandLockup`, and its document titles add the name through `useDocumentTitle`. A company's pages
 * name the company (`useIdentityName`).
 */
export function useProductName(): string {
  const { language } = useLanguage()
  return productName(language)
}

/**
 * Applies the signed-in user's language (their preference, else the company's default) whenever
 * it changes: at sign-in, when the session is first known, after a change saved from another tab
 * or device. Signed out, the device's language stays. Mounted once, in `RootLayout`.
 *
 * Only a change of the *session's* language is applied: while a switch is being saved, a session
 * check that still names the old preference does not switch the screen back.
 *
 * A language picked with the switch on the sign-in page (this visit) is not dropped at sign-in:
 * when the account has no preference of its own and the company's default differs, the screen
 * stays in the picked language and it is saved as the account's preference
 * (PATCH /auth/preferences), so it also holds on the next sign-in and on other devices.
 */
export function LanguageController(): null {
  const me = useCachedMe()
  const queryClient = useQueryClient()
  const language = me ? sessionLanguage(me) : null
  const applied = useRef<Language | null>(null)

  useLayoutEffect(() => {
    if (language === applied.current) return
    applied.current = language
    if (!me || !language) return
    // Taken at every sign-in, used or not: a choice made before one person signed in never
    // reaches the next person on a shared device. An account's own language wins (F10-3).
    const chosen = takeChosenLanguage()
    if (chosen && chosen !== language && preferredLanguageOf(me) === null) {
      applyLanguage(chosen)
      // Saved quietly: if it fails, the screen keeps the choice for now and the next sign-in
      // follows the company again.
      updatePreferences({ language: chosen }).then(
        (saved) => queryClient.setQueryData(queryKeys.me, saved),
        () => {},
      )
      return
    }
    applyLanguage(language)
    // A new `me` with the same language (a heartbeat) returns at the first line.
  }, [language, me, queryClient])

  return null
}

export interface SwitchLanguageOptions<T> {
  /**
   * Saves the choice to the signed-in account and answers with the updated session, or returns null
   * when nobody is signed in: the choice is then only remembered on the device, and noted for the
   * sign-in (`markLanguageChosen`).
   */
  save: (language: Language) => Promise<T> | null
  /** Puts the saved session in the cache. */
  onSaved: (session: T) => void
  /** Groups the mutation with its session's (`mutationKey`), so a sign-out of the other session leaves it alone. */
  mutationKey?: readonly unknown[]
}

/**
 * Switches the UI language at once (optimistic) and saves it where `save` says; if saving fails,
 * the previous language comes back and a toast says why. The company session's switch is
 * `useChangeLanguage`; the platform owner's (Phase 11) saves through its own preferences.
 */
export function useSwitchLanguage<T>({ save, onSaved, mutationKey }: SwitchLanguageOptions<T>) {
  const toast = useToast()
  return useMutation({
    mutationKey,
    mutationFn: async (language: Language): Promise<T | null> => {
      const saving = save(language)
      if (saving === null) {
        // Signed out (the sign-in page): kept on the device, and saved to the account at sign-in.
        markLanguageChosen()
        return null
      }
      return saving
    },
    onMutate: (language) => {
      const previous = currentLanguage()
      applyLanguage(language)
      return { previous }
    },
    onSuccess: (session) => {
      if (session !== null) onSaved(session)
    },
    onError: (error, _language, context) => {
      if (context) applyLanguage(context.previous)
      toast.show({ tone: 'danger', title: i18n.t('language.changeFailed'), description: getErrorMessage(error) })
    },
  })
}

/**
 * Switches the UI language at once. Signed in, the choice is saved to the account
 * (PATCH /auth/preferences) and the session is updated with the answer; if saving fails, the
 * previous language comes back and a toast says why. Signed out, it is remembered on the device.
 */
export function useChangeLanguage() {
  const queryClient = useQueryClient()
  return useSwitchLanguage<Me>({
    save: (language) => (queryClient.getQueryData<Me | null>(queryKeys.me) ? updatePreferences({ language }) : null),
    onSaved: (me) => queryClient.setQueryData(queryKeys.me, me),
  })
}

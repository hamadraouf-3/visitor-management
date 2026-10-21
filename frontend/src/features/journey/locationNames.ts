import { useCallback } from 'react'
import type { Language } from '../../i18n'
import { useLanguage } from '../../i18n/useLanguage'

/*
 * A building, floor or zone has two names, as a department has (phase 10 shared contract B): `name`,
 * the default one, and `name_ar`, its Arabic name or null. The Arabic UI shows `name_ar` when it is set,
 * else `name`; the English UI always `name`.
 */

export interface LocationNames {
  name: string
  name_ar?: string | null
}

export function locationName(location: LocationNames, language: Language): string {
  const arabic = typeof location.name_ar === 'string' && location.name_ar.trim() !== '' ? location.name_ar : null
  return (language === 'ar' ? arabic : null) ?? location.name
}

/** The name in the other language, when the place has both and they differ (the admin's editor shows both). */
export function otherLocationName(location: LocationNames, language: Language): string | null {
  const arabic = typeof location.name_ar === 'string' && location.name_ar.trim() !== '' ? location.name_ar : null
  if (arabic === null) return null
  const other = language === 'ar' ? location.name : arabic
  return other === locationName(location, language) ? null : other
}

/** `locationName` in the UI language, re-rendering on a switch. */
export function useLocationName(): (location: LocationNames) => string {
  const { language } = useLanguage()
  return useCallback((location: LocationNames) => locationName(location, language), [language])
}

/** Orders places by the name the UI shows, as a person of that language sorts (digits by value). */
export function compareLocationNames(language: Language): (a: LocationNames, b: LocationNames) => number {
  const collator = new Intl.Collator(language, { sensitivity: 'base', numeric: true })
  return (a, b) => collator.compare(locationName(a, language), locationName(b, language))
}

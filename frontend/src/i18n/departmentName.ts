import { useCallback } from 'react'
import { currentLanguage, type Language } from './index'
import { useLanguage } from './useLanguage'

/*
 * A department has two names (phase 10 shared contract, the user's request of 2026-10-08: "when the
 * UI is English, even the department in English"): `name`, the default (English) one, and `name_ar`,
 * its Arabic name or null. The UI shows `name_ar` when it is Arabic and `name_ar` is set, else `name`.
 *
 * This module is the only reader of the two names for display: components call `useDepartmentName()`,
 * code outside components (chart rows, list filters) `departmentDisplayName(…, language)`.
 * `departmentNameGuard.test.ts` fails when any other source reads a department's `name` (only the
 * forms that edit the names, and the department's own matching rules, are listed there as exceptions).
 */

/** What carries a department's names: `DepartmentRef`, `Department`, a report's department row. */
export interface DepartmentNames {
  /** The default (English) name. */
  name: string
  /** The Arabic name; null (or absent, from an older API or a mock) when unset. */
  name_ar?: string | null
}

/** The Arabic name when it is set (not blank), else null. Checked at run time: a mocked or older API may leave it out. */
function arabicNameOf(department: DepartmentNames): string | null {
  const nameAr: unknown = department.name_ar
  return typeof nameAr === 'string' && nameAr.trim() !== '' ? nameAr : null
}

/** A department's name in the UI language: its Arabic name in the Arabic UI when it has one, else `name`. */
export function departmentDisplayName(department: DepartmentNames, language: Language = currentLanguage()): string {
  return (language === 'ar' ? arabicNameOf(department) : null) ?? department.name
}

/**
 * The department's name in the other language, when it differs from the one shown: `name` under an
 * Arabic name, the Arabic name under `name` in English. Null when the department has one name only.
 * For the administrators' department list, which shows both.
 */
export function departmentOtherName(department: DepartmentNames, language: Language = currentLanguage()): string | null {
  const nameAr = arabicNameOf(department)
  if (nameAr === null) return null
  const other = language === 'ar' ? department.name : nameAr
  return other === departmentDisplayName(department, language) ? null : other
}

/** Every name a person may type to find the department (the shown one first). */
export function departmentSearchNames(department: DepartmentNames, language: Language = currentLanguage()): string[] {
  const other = departmentOtherName(department, language)
  return other === null ? [departmentDisplayName(department, language)] : [departmentDisplayName(department, language), other]
}

/** Orders departments by the name the UI shows, as a person of that language sorts (digits by value). */
export function compareDepartmentNames(language: Language = currentLanguage()): (a: DepartmentNames, b: DepartmentNames) => number {
  const collator = new Intl.Collator(language, { sensitivity: 'base', numeric: true })
  return (a, b) => collator.compare(departmentDisplayName(a, language), departmentDisplayName(b, language))
}

/**
 * The department label for the UI language, re-rendering on a switch: `label(visit.department)`.
 * An empty string for no department, so the caller's own "—" or omission decides what shows.
 */
export function useDepartmentName(): (department: DepartmentNames | null | undefined) => string {
  const { language } = useLanguage()
  return useCallback((department: DepartmentNames | null | undefined) => (department ? departmentDisplayName(department, language) : ''), [language])
}

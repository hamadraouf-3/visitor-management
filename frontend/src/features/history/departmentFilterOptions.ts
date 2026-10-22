import { compareDepartmentNames, departmentSearchNames } from '../../i18n/departmentName'
import { currentLanguage, type Language } from '../../i18n'
import type { Department } from '../../types/api'
import { findMatch } from '../../utils/highlight'

/**
 * Departments matching the typed text (case- and accent-insensitive) in either of their names,
 * active first, then by the name the UI shows (`language`).
 */
export function departmentFilterOptions(departments: readonly Department[], query: string, language: Language = currentLanguage()): Department[] {
  const term = query.trim()
  const byName = compareDepartmentNames(language)
  return departments
    .filter((department) => term === '' || departmentSearchNames(department, language).some((name) => findMatch(name, term) !== null))
    .toSorted((a, b) => Number(b.is_active) - Number(a.is_active) || byName(a, b))
}

/**
 * The selected option for a department id. Null while the list loads (the combobox shows the
 * name as soon as it is known), and a stand-in when the id is not in the caller's list, e.g. an
 * inactive department in a link an administrator shared with a reception user.
 */
export function departmentFilterValue(
  id: string | null,
  departments: readonly Department[] | undefined,
  notListedLabel = 'Department not listed',
): Department | null {
  if (id === null || departments === undefined) return null
  return (
    departments.find((department) => department.id === id) ?? {
      id,
      name: notListedLabel,
      name_ar: null,
      is_active: false,
      created_at: '',
      updated_at: '',
      floor: null,
    }
  )
}

import { isApiError } from '../../api/client'
import { currentLanguage, i18n, type Language } from '../../i18n'
import { compareDepartmentNames } from '../../i18n/departmentName'
import type { Department, DepartmentCreate, DepartmentUpdate } from '../../types/api'
import { maxLengthMessage, type FormErrors, type ServerFieldPaths } from '../../utils/forms'

/*
 * The department dialog's pure logic. A department has two names (phase 10 shared contract B): the
 * default (English) `name`, required, and the optional Arabic `name_ar`, which the Arabic UI shows
 * instead. This module edits and compares the stored names, so it reads them directly (the one
 * exception besides `i18n/departmentName.ts` in `departmentNameGuard.test.ts`); everything shown to
 * people goes through `useDepartmentName`.
 */

/** `departments.name` and `departments.name_ar` limit (§4); the server enforces the same and trims. */
export const DEPARTMENT_NAME_MAX = 120

export interface DepartmentFormValues {
  name: string
  /** '' = no Arabic name (the Arabic UI then shows `name`). */
  nameAr: string
}

export type DepartmentField = keyof DepartmentFormValues

/** The dialog's fields and the request paths the server reports them under. */
export const DEPARTMENT_FIELDS: ServerFieldPaths<DepartmentField> = { name: 'name', nameAr: 'name_ar' }

const t = i18n.getFixedT(null, 'admin')

/** The values the dialog opens with: the department's stored names, or empty for a new one. */
export function departmentFormValues(department?: Department): DepartmentFormValues {
  return { name: department?.name ?? '', nameAr: department?.name_ar ?? '' }
}

/** The stored names compare trimmed and ignoring case (§4 `uq_departments_company_name`, and the same for `name_ar`). */
function sameName(stored: string | null | undefined, wanted: string): boolean {
  return wanted !== '' && typeof stored === 'string' && stored.trim().toLowerCase() === wanted.toLowerCase()
}

/**
 * Whether another department already has this name. Names are unique per company, ignoring case
 * (§4 `uq_departments_company_name`), inactive ones included; the server has the final word
 * (409 CONFLICT), this only spares a request. (Name against name only; `validateDepartment` also
 * compares across the languages.)
 */
export function departmentNameTaken(name: string, departments: readonly Department[], exceptId?: string): boolean {
  return departments.some((department) => department.id !== exceptId && sameName(department.name, name.trim()))
}

/** The same for the Arabic name: unique per company when set, ignoring case. */
export function departmentArabicNameTaken(nameAr: string, departments: readonly Department[], exceptId?: string): boolean {
  return departments.some((department) => department.id !== exceptId && sameName(department.name_ar, nameAr.trim()))
}

/**
 * The dialog's validation: the name is required, both names at most 120 characters, and no name
 * may be another department's name or Arabic name, ignoring case and inactive ones included
 * (B10-29: two departments never read the same, in either UI language). The same language is
 * reported first; an inactive department's says so (it can be reactivated instead). As on the
 * server, a value that only changes case is not compared across the languages, so a department
 * saved before the rule that shares a value with another stays editable. `department` is the one
 * being renamed (its own names are not duplicates).
 */
export function validateDepartment(
  values: DepartmentFormValues,
  departments: readonly Department[],
  department?: Department,
): FormErrors<DepartmentField> {
  const errors: FormErrors<DepartmentField> = {}
  const others = departments.filter((candidate) => candidate.id !== department?.id)
  const nameTaken = (holder: Department) => (holder.is_active ? t('departments.validation.duplicate') : t('departments.validation.duplicateInactive'))
  const arabicNameTaken = (holder: Department) =>
    holder.is_active ? t('departments.validation.duplicateAr') : t('departments.validation.duplicateArInactive')

  const name = values.name.trim()
  if (!name) errors.name = t('departments.validation.nameRequired')
  else if (name.length > DEPARTMENT_NAME_MAX) errors.name = maxLengthMessage(DEPARTMENT_NAME_MAX)
  else {
    const duplicate = others.find((candidate) => sameName(candidate.name, name))
    const crossed = sameName(department?.name, name) ? undefined : others.find((candidate) => sameName(candidate.name_ar, name))
    if (duplicate) errors.name = nameTaken(duplicate)
    else if (crossed) errors.name = arabicNameTaken(crossed)
  }

  const nameAr = values.nameAr.trim()
  if (nameAr.length > DEPARTMENT_NAME_MAX) errors.nameAr = maxLengthMessage(DEPARTMENT_NAME_MAX)
  else {
    const duplicate = others.find((candidate) => sameName(candidate.name_ar, nameAr))
    const crossed = sameName(department?.name_ar, nameAr) ? undefined : others.find((candidate) => sameName(candidate.name, nameAr))
    if (duplicate) errors.nameAr = arabicNameTaken(duplicate)
    else if (crossed) errors.nameAr = nameTaken(crossed)
  }
  return errors
}

/** POST /departments: the trimmed name, and the Arabic name when one was typed. */
export function toDepartmentCreate(values: DepartmentFormValues): DepartmentCreate {
  const nameAr = values.nameAr.trim()
  return { name: values.name.trim(), ...(nameAr ? { name_ar: nameAr } : {}) }
}

/**
 * PATCH /departments/{id} with only what changed, or null when nothing did. A cleared Arabic name is
 * sent as null (the server clears it). Call after `validateDepartment` passed.
 */
export function toDepartmentUpdate(department: Department, values: DepartmentFormValues): DepartmentUpdate | null {
  const body: DepartmentUpdate = {}
  const name = values.name.trim()
  if (name !== department.name) body.name = name
  const nameAr = values.nameAr.trim()
  if (nameAr !== (department.name_ar ?? '')) body.name_ar = nameAr || null
  return Object.keys(body).length > 0 ? body : null
}

/** The field a 409 CONFLICT names (`details.field`): the Arabic name's, else the name's. */
export function conflictField(error: unknown): DepartmentField {
  return isApiError(error) && error.details.field === 'name_ar' ? 'nameAr' : 'name'
}

/** Active first, then by the name the UI shows. */
export function sortDepartments(departments: readonly Department[], language: Language = currentLanguage()): Department[] {
  const byName = compareDepartmentNames(language)
  return departments.toSorted((a, b) => Number(b.is_active) - Number(a.is_active) || byName(a, b))
}

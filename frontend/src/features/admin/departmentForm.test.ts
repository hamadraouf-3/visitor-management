import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import type { Department } from '../../types/api'
import { conflictField, departmentFormValues, sortDepartments, toDepartmentCreate, toDepartmentUpdate, validateDepartment } from './departmentForm'

const department = (id: string, name: string, nameAr: string | null, isActive = true): Department => ({
  id,
  name,
  name_ar: nameAr,
  is_active: isActive,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
})

const FINANCE = department('fin', 'Finance', 'المالية')
const ARCHIVE = department('arc', 'Archive', 'الأرشيف', false)
const LEGAL = department('leg', 'Legal', null)
const ALL = [FINANCE, ARCHIVE, LEGAL]

const conflict = (field: string) => new ApiError({ status: 409, code: 'CONFLICT', message: 'Taken.', details: { field } })

describe('department form', () => {
  it('opens with the stored names, or empty for a new department', () => {
    expect(departmentFormValues(FINANCE)).toEqual({ name: 'Finance', nameAr: 'المالية' })
    expect(departmentFormValues(LEGAL)).toEqual({ name: 'Legal', nameAr: '' })
    expect(departmentFormValues()).toEqual({ name: '', nameAr: '' })
  })

  it('requires the name only, and limits both names to 120 characters', () => {
    expect(validateDepartment({ name: ' ', nameAr: '' }, ALL)).toEqual({ name: 'Enter a department name.' })
    expect(validateDepartment({ name: 'Security', nameAr: '' }, ALL)).toEqual({})
    const tooLong = validateDepartment({ name: 'x'.repeat(121), nameAr: 'ع'.repeat(121) }, ALL)
    expect(tooLong.name).toMatch(/120/)
    expect(tooLong.nameAr).toMatch(/120/)
  })

  it('finds another department’s name or Arabic name, ignoring case and spaces, but not the department’s own', () => {
    expect(validateDepartment({ name: ' finance ', nameAr: '' }, ALL)).toEqual({ name: 'A department with this name already exists.' })
    expect(validateDepartment({ name: 'Records', nameAr: ' الأرشيف ' }, ALL)).toEqual({
      nameAr: 'An inactive department has this Arabic name. Reactivate it instead.',
    })
    expect(validateDepartment({ name: 'Finance', nameAr: 'المالية' }, ALL, FINANCE)).toEqual({})
    // Across the languages too (B10-29): Finance's name is taken as an Arabic name, though Finance has an Arabic name.
    expect(validateDepartment({ name: 'Records', nameAr: 'Finance' }, ALL)).toEqual({ nameAr: 'A department with this name already exists.' })
  })

  describe('no name is another department’s name or Arabic name, across the languages (B10-29)', () => {
    const IT = department('it', 'IT', 'تقنية المعلومات')
    const OPERATIONS = department('ops', 'Operations', 'العمليات')
    const WITH_IT = [...ALL, IT, OPERATIONS]
    const nameTaken = 'A department with this name already exists.'
    const nameTakenInactive = 'An inactive department has this name. Reactivate it instead.'
    const arabicNameTaken = 'A department with this Arabic name already exists.'
    const arabicNameTakenInactive = 'An inactive department has this Arabic name. Reactivate it instead.'

    it('refuses a name that is another department’s Arabic name, on the name, with or without an Arabic name', () => {
      expect(validateDepartment({ name: 'تقنية المعلومات', nameAr: '' }, WITH_IT)).toEqual({ name: arabicNameTaken })
      expect(validateDepartment({ name: 'تقنية المعلومات', nameAr: 'الحاسوب' }, WITH_IT)).toEqual({ name: arabicNameTaken })
      expect(validateDepartment({ name: ' الأرشيف ', nameAr: '' }, WITH_IT)).toEqual({ name: arabicNameTakenInactive })
      // The review's case: «العمليات» / "Operations" beside Operations / «العمليات», refused on both fields.
      expect(validateDepartment({ name: 'العمليات', nameAr: 'Operations' }, WITH_IT)).toEqual({ name: arabicNameTaken, nameAr: nameTaken })
    })

    it('refuses an Arabic name that is another department’s name, on the Arabic name, ignoring case and spaces', () => {
      expect(validateDepartment({ name: 'Cross', nameAr: 'Legal' }, WITH_IT)).toEqual({ nameAr: nameTaken })
      expect(validateDepartment({ name: 'Cross', nameAr: ' LEGAL ' }, WITH_IT)).toEqual({ nameAr: nameTaken })
      expect(validateDepartment({ name: 'Procurement', nameAr: 'finance' }, WITH_IT)).toEqual({ nameAr: nameTaken })
      expect(validateDepartment({ name: 'Cross', nameAr: 'archive' }, WITH_IT)).toEqual({ nameAr: nameTakenInactive })
    })

    it('checks a rename in either language', () => {
      expect(validateDepartment({ name: 'تقنية المعلومات', nameAr: '' }, WITH_IT, LEGAL)).toEqual({ name: arabicNameTaken })
      expect(validateDepartment({ name: 'IT', nameAr: 'legal' }, WITH_IT, IT)).toEqual({ nameAr: nameTaken })
      // Clearing an Arabic name never conflicts.
      expect(validateDepartment({ name: 'IT', nameAr: '' }, WITH_IT, IT)).toEqual({})
    })

    it('never counts the department’s own names, and leaves a value that only changes case alone', () => {
      expect(validateDepartment({ name: 'Legal', nameAr: 'LEGAL' }, WITH_IT, LEGAL)).toEqual({})
      expect(validateDepartment({ name: 'تقنية المعلومات', nameAr: 'IT' }, WITH_IT, IT)).toEqual({})
      expect(validateDepartment({ name: 'Security', nameAr: 'security' }, WITH_IT)).toEqual({})
      // Two departments that already share a value (saved before the rule): the other name and a change of case pass.
      const TWIN = department('twin', 'تقنية المعلومات', null)
      expect(validateDepartment({ name: 'Information Technology', nameAr: 'تقنية المعلومات' }, [...WITH_IT, TWIN], IT)).toEqual({})
      const PAIR = department('pair', 'operations ar', null)
      const SHARED = department('shared', 'Desk', 'Operations AR')
      expect(validateDepartment({ name: 'OPERATIONS AR', nameAr: '' }, [...WITH_IT, PAIR, SHARED], PAIR)).toEqual({})
    })

    it('reports the same language first, as the server does', () => {
      expect(validateDepartment({ name: 'Cross', nameAr: 'تقنية المعلومات' }, WITH_IT)).toEqual({ nameAr: arabicNameTaken })
      expect(validateDepartment({ name: 'legal', nameAr: '' }, WITH_IT)).toEqual({ name: nameTaken })
    })
  })

  it('creates with the Arabic name only when one was typed', () => {
    expect(toDepartmentCreate({ name: ' Security ', nameAr: '  ' })).toEqual({ name: 'Security' })
    expect(toDepartmentCreate({ name: 'Security', nameAr: ' الأمن ' })).toEqual({ name: 'Security', name_ar: 'الأمن' })
  })

  it('updates only what changed, a cleared Arabic name as null, and nothing when nothing changed', () => {
    expect(toDepartmentUpdate(FINANCE, { name: 'Finance ', nameAr: 'المالية' })).toBeNull()
    expect(toDepartmentUpdate(FINANCE, { name: 'Finance', nameAr: '' })).toEqual({ name_ar: null })
    expect(toDepartmentUpdate(LEGAL, { name: 'Legal Affairs', nameAr: 'الشؤون القانونية' })).toEqual({ name: 'Legal Affairs', name_ar: 'الشؤون القانونية' })
  })

  it('reads the field of a 409 from details.field', () => {
    expect(conflictField(conflict('name_ar'))).toBe('nameAr')
    expect(conflictField(conflict('name'))).toBe('name')
    expect(conflictField(null)).toBe('name')
  })

  it('sorts active departments first, then by the name the UI language shows', () => {
    const technology = department('it', 'IT', 'تقنية المعلومات')
    expect(sortDepartments([LEGAL, ARCHIVE, technology, FINANCE], 'en').map((item) => item.id)).toEqual(['fin', 'it', 'leg', 'arc'])
    expect(sortDepartments([LEGAL, ARCHIVE, technology, FINANCE], 'ar').map((item) => item.id)).toEqual(['fin', 'it', 'leg', 'arc'])
  })
})

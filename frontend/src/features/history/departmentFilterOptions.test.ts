import { describe, expect, it } from 'vitest'
import type { Department } from '../../types/api'
import { departmentFilterOptions, departmentFilterValue } from './departmentFilterOptions'

const department = (id: string, name: string, nameAr: string | null, isActive = true): Department => ({
  id,
  name,
  name_ar: nameAr,
  is_active: isActive,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  floor: null,
})

const DEPARTMENTS = [
  department('it', 'IT', 'تقنية المعلومات'),
  department('fin', 'Finance', 'المالية'),
  department('arc', 'Archive', 'الأرشيف', false),
  department('ops', 'Operations', null),
]

const ids = (departments: Department[]) => departments.map((item) => item.id)

describe('departmentFilterOptions', () => {
  it('sorts active departments first, then by the name the UI language shows', () => {
    expect(ids(departmentFilterOptions(DEPARTMENTS, '', 'en'))).toEqual(['fin', 'it', 'ops', 'arc'])
    expect(ids(departmentFilterOptions(DEPARTMENTS, '', 'ar'))).toEqual(['fin', 'it', 'ops', 'arc'])
  })

  it('finds a department by either of its names, ignoring case and accents', () => {
    expect(ids(departmentFilterOptions(DEPARTMENTS, 'المال', 'en'))).toEqual(['fin'])
    expect(ids(departmentFilterOptions(DEPARTMENTS, 'finance', 'ar'))).toEqual(['fin'])
    expect(ids(departmentFilterOptions(DEPARTMENTS, 'oper', 'ar'))).toEqual(['ops'])
    expect(ids(departmentFilterOptions(DEPARTMENTS, 'xyz', 'ar'))).toEqual([])
  })
})

describe('departmentFilterValue', () => {
  it('stands in for a department the caller cannot list, with no Arabic name', () => {
    expect(departmentFilterValue('gone', DEPARTMENTS, 'Not listed')).toMatchObject({ id: 'gone', name: 'Not listed', name_ar: null, is_active: false })
    expect(departmentFilterValue('fin', DEPARTMENTS)).toBe(DEPARTMENTS[1])
    expect(departmentFilterValue(null, DEPARTMENTS)).toBeNull()
  })
})

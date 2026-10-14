import { act, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { renderWithProviders } from '../test/render'
import type { Department, DepartmentRef } from '../types/api'
import { compareDepartmentNames, departmentDisplayName, departmentOtherName, departmentSearchNames, useDepartmentName } from './departmentName'
import { i18n } from './index'

/*
 * The department's name follows the UI language (phase 10 shared contract B, the user's request of
 * 2026-10-08: "when the UI is English, even the department in English"): the Arabic name in the
 * Arabic UI when the department has one, else its default (English) name.
 */

const FINANCE: DepartmentRef = { id: 'd-1', name: 'Finance', name_ar: 'المالية' }
const LEGAL: DepartmentRef = { id: 'd-2', name: 'Legal', name_ar: null }

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('departmentDisplayName', () => {
  it('shows the Arabic name in Arabic and the name in English', () => {
    expect(departmentDisplayName(FINANCE, 'ar')).toBe('المالية')
    expect(departmentDisplayName(FINANCE, 'en')).toBe('Finance')
  })

  it('shows the name in both languages when there is no Arabic name (null, blank or left out)', () => {
    expect(departmentDisplayName(LEGAL, 'ar')).toBe('Legal')
    expect(departmentDisplayName(LEGAL, 'en')).toBe('Legal')
    expect(departmentDisplayName({ ...LEGAL, name_ar: '   ' }, 'ar')).toBe('Legal')
    // An older API or a mocked one may leave the field out.
    expect(departmentDisplayName({ name: 'Legal' }, 'ar')).toBe('Legal')
  })

  it('follows the current UI language by default', async () => {
    expect(departmentDisplayName(FINANCE)).toBe('Finance')
    await i18n.changeLanguage('ar')
    expect(departmentDisplayName(FINANCE)).toBe('المالية')
  })
})

describe('departmentOtherName and departmentSearchNames', () => {
  it('give the name in the other language when the department has both', () => {
    expect(departmentOtherName(FINANCE, 'en')).toBe('المالية')
    expect(departmentOtherName(FINANCE, 'ar')).toBe('Finance')
    expect(departmentSearchNames(FINANCE, 'ar')).toEqual(['المالية', 'Finance'])
    expect(departmentSearchNames(FINANCE, 'en')).toEqual(['Finance', 'المالية'])
  })

  it('give nothing more for a department with one name (or the same name twice)', () => {
    expect(departmentOtherName(LEGAL, 'en')).toBeNull()
    expect(departmentOtherName(LEGAL, 'ar')).toBeNull()
    expect(departmentOtherName({ name: 'IT', name_ar: 'IT' }, 'ar')).toBeNull()
    expect(departmentSearchNames(LEGAL, 'ar')).toEqual(['Legal'])
  })
})

describe('compareDepartmentNames', () => {
  it('orders by the name the UI language shows, digits by value', () => {
    const departments: Department[] = [
      { id: 'a', name: 'Administration', name_ar: 'الإدارة', is_active: true, created_at: '', updated_at: '' },
      { id: 'b', name: 'Bookkeeping', name_ar: 'المحاسبة', is_active: true, created_at: '', updated_at: '' },
      { id: 'c', name: 'Team 10', name_ar: null, is_active: true, created_at: '', updated_at: '' },
      { id: 'd', name: 'Team 9', name_ar: null, is_active: true, created_at: '', updated_at: '' },
    ]
    expect(departments.toSorted(compareDepartmentNames('en')).map((department) => department.id)).toEqual(['a', 'b', 'd', 'c'])
    // In Arabic: «الإدارة», «المحاسبة» by their Arabic names; the departments without one by their names.
    const arabic = departments.toSorted(compareDepartmentNames('ar')).map((department) => departmentDisplayName(department, 'ar'))
    expect(arabic.indexOf('الإدارة')).toBeLessThan(arabic.indexOf('المحاسبة'))
    expect(arabic.indexOf('Team 9')).toBeLessThan(arabic.indexOf('Team 10'))
  })
})

const labels = () => screen.getAllByTestId('label').map((element) => element.textContent)

function DepartmentLabel({ department }: { department: DepartmentRef | null }) {
  const departmentName = useDepartmentName()
  return <p data-testid="label">{departmentName(department) || '—'}</p>
}

describe('useDepartmentName', () => {
  it('renders the label in the UI language and follows a switch', async () => {
    renderWithProviders(
      <>
        <DepartmentLabel department={FINANCE} />
        <DepartmentLabel department={LEGAL} />
        <DepartmentLabel department={null} />
      </>,
    )
    expect(labels()).toEqual(['Finance', 'Legal', '—'])

    await act(() => i18n.changeLanguage('ar'))
    expect(labels()).toEqual(['المالية', 'Legal', '—'])

    await act(() => i18n.changeLanguage('en'))
    expect(labels()).toEqual(['Finance', 'Legal', '—'])
  })
})

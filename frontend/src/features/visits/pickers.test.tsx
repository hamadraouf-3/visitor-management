import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Field } from '../../components/ui/Field'
import { i18n } from '../../i18n'
import { jsonResponse, mockApi } from '../../test/api'
import { renderWithProviders } from '../../test/render'
import type { Department, Host } from '../../types/api'
import { DepartmentSelect, HostPicker } from './pickers'

/*
 * The pickers name departments in the UI language (phase 10 shared contract B): the Arabic name in
 * the Arabic UI when the department has one, sorted by the name shown.
 */

const department = (id: string, name: string, nameAr: string | null): Department => ({
  id,
  name,
  name_ar: nameAr,
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  floor: null,
})

const DEPARTMENTS = [department('d-it', 'IT', 'تقنية المعلومات'), department('d-fin', 'Finance', 'المالية'), department('d-ops', 'Operations', null)]

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('DepartmentSelect', () => {
  it('lists the departments by the name of the UI language, sorted by it, and follows a switch', async () => {
    mockApi({ 'GET /departments': () => jsonResponse(DEPARTMENTS) })
    renderWithProviders(
      <Field label="Department">
        <DepartmentSelect value="" onChange={() => {}} current={{ id: 'd-old', name: 'Archive', name_ar: 'الأرشيف' }} markInactive />
      </Field>,
    )
    const select = screen.getByRole('combobox', { name: /Department/ })
    const options = () => within(select).getAllByRole('option').map((option) => option.textContent)
    await waitFor(() => expect(options()).toContain('Finance'))
    expect(options()).toEqual(['No department', 'Archive (inactive)', 'Finance', 'IT', 'Operations'])

    await act(() => i18n.changeLanguage('ar'))
    // In Arabic order (the Arabic script first); Operations has no Arabic name and keeps its name.
    expect(options()).toEqual(['بدون قسم', 'الأرشيف (غير نشط)', 'المالية', 'تقنية المعلومات', 'Operations'])
  })
})

describe('HostPicker', () => {
  it('names each host’s department in the UI language', async () => {
    const hosts: Host[] = [
      { id: 'h-1', full_name: 'Omar Khalil', phone: null, department: { id: 'd-fin', name: 'Finance', name_ar: 'المالية' } },
      { id: 'h-2', full_name: 'Sara Odeh', phone: null, department: { id: 'd-ops', name: 'Operations', name_ar: null } },
    ]
    mockApi({ 'GET /users/hosts': () => jsonResponse(hosts) })
    await i18n.changeLanguage('ar')
    const { user } = renderWithProviders(
      <Field label="Host">
        <HostPicker value={null} onChange={() => {}} />
      </Field>,
    )
    await user.click(screen.getByRole('combobox', { name: /Host/ }))
    const listbox = await screen.findByRole('listbox')
    expect(await within(listbox).findByRole('option', { name: /Omar Khalil/ })).toHaveTextContent('Omar Khalilالمالية')
    expect(within(listbox).getByRole('option', { name: /Sara Odeh/ })).toHaveTextContent('Sara OdehOperations')
  })
})

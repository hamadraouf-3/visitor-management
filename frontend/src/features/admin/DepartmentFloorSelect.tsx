import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { Select } from '../../components/ui/Select'
import { useToast } from '../../components/ui/toastContext'
import { useDepartmentName } from '../../i18n/departmentName'
import { useLanguage } from '../../i18n/useLanguage'
import type { Department } from '../../types/api'
import { actionErrorMessage } from '../../utils/forms'
import type { AreaOptions } from '../accessAreas/accessAreas'
import { departmentFloorChoices } from './departmentFloor'
import { useUpdateDepartment } from './queries'

export interface DepartmentFloorSelectProps {
  department: Department
  /** The company's active places; undefined while they load. */
  options: AreaOptions | undefined
}

/**
 * A department's floor (Phase 16), saved when chosen (`PATCH /departments/{id}` with `floor_id`, null for
 * «بدون طابق» / "No floor"), with a toast either way. While it is saved the select is busy and shows the
 * choice, and keeps the focus (not disabled: a disabled control drops it; a change meanwhile is ignored, F16-45);
 * the answer is the list's at once. A refusal puts the saved floor back. Named per row for assistive technology
 * («طابق المالية»).
 */
export function DepartmentFloorSelect({ department, options }: DepartmentFloorSelectProps) {
  const { t } = useTranslation('admin')
  const { language } = useLanguage()
  const toast = useToast()
  const departmentName = useDepartmentName()
  const update = useUpdateDepartment()
  const name = departmentName(department)
  const choices = departmentFloorChoices(options, department.floor, language)
  const saved = department.floor?.id ?? ''
  // The choice being saved; the saved floor otherwise (also after a refusal).
  const pending = update.isPending ? update.variables?.body.floor_id : undefined
  const value = pending === undefined ? saved : (pending ?? '')

  const choose = (floorId: string) => {
    if (floorId === saved || update.isPending) return
    update.mutate(
      { id: department.id, body: { floor_id: floorId || null } },
      {
        onSuccess: () => toast.show({ tone: 'success', title: t('departments.floorSaved', { name }) }),
        onError: (error) => toast.show({ tone: 'danger', title: t('departments.floorFailed', { name }), description: actionErrorMessage(error) }),
      },
    )
  }

  return (
    <Select
      data-department-floor={department.id}
      aria-label={t('departments.floorOf', { name })}
      aria-busy={update.isPending || options === undefined || undefined}
      aria-disabled={update.isPending || undefined}
      value={value}
      onChange={(event) => choose(event.target.value)}
      className="min-w-0 md:max-w-56"
    >
      <option value="">{t('departments.noFloor')}</option>
      {choices.current && <option value={choices.current.id}>{choices.current.label}</option>}
      {choices.groups.map((group, index) => {
        const floors = group.floors.map((floor) => (
          <option key={floor.id} value={floor.id}>
            {floor.label}
          </option>
        ))
        // One building: its floors alone; several: a group a building.
        return group.label === null ? (
          <Fragment key={index}>{floors}</Fragment>
        ) : (
          <optgroup key={index} label={group.label}>
            {floors}
          </optgroup>
        )
      })}
    </Select>
  )
}

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getErrorMessage } from '../../api/client'
import { listDepartments } from '../../api/departments'
import { queryKeys } from '../../api/queryKeys'
import { Combobox } from '../../components/ui/Combobox'
import { HighlightMatch } from '../../components/ui/HighlightMatch'
import { useDepartmentName } from '../../i18n/departmentName'
import { useLanguage } from '../../i18n/useLanguage'
import type { Department, DepartmentListParams } from '../../types/api'
import { departmentFilterOptions, departmentFilterValue } from './departmentFilterOptions'

const REFERENCE_STALE_MS = 5 * 60_000

export interface DepartmentFilterProps {
  /** Selected department id, or null for every department. */
  value: string | null
  onChange: (departmentId: string | null) => void
  /**
   * Administrators may list inactive departments too (`include_inactive`, B1-19); other roles
   * get 403 for it and see the active ones.
   */
  includeInactive: boolean
}

/**
 * Department picker for list filters: a combobox that loads the department list the first time
 * it is opened (or when a department is already selected), and filters it as the user types.
 * Use inside a `Field`.
 */
export function DepartmentFilter({ value, onChange, includeInactive }: DepartmentFilterProps) {
  const { t } = useTranslation('history')
  const { language } = useLanguage()
  const departmentName = useDepartmentName()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const params: DepartmentListParams = includeInactive ? { include_inactive: true } : {}
  const departments = useQuery({
    queryKey: queryKeys.departments.list(params),
    queryFn: ({ signal }) => listDepartments(params, { signal }),
    enabled: open || value !== null,
    staleTime: REFERENCE_STALE_MS,
  })

  const all = departments.data
  const selected = departmentFilterValue(value, all, t('departmentFilter.notListed'))
  return (
    <Combobox<Department>
      value={selected}
      onChange={(department) => onChange(department?.id ?? null)}
      options={departmentFilterOptions(all ?? [], query, language)}
      getOptionKey={(department) => department.id}
      getOptionLabel={departmentName}
      renderOption={(department, filter) => (
        <span className="flex items-center justify-between gap-2">
          <span>
            <HighlightMatch text={departmentName(department)} query={filter} />
          </span>
          {!department.is_active && <span className="text-xs text-fg-muted">{t('departmentFilter.inactive')}</span>}
        </span>
      )}
      onQueryChange={setQuery}
      onOpenChange={setOpen}
      loading={open && departments.isPending}
      errorMessage={departments.isError ? getErrorMessage(departments.error) : null}
      emptyMessage={t('departmentFilter.empty')}
      placeholder={t('departmentFilter.all')}
    />
  )
}

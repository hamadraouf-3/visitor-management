import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useActiveDepartments } from '../../api/queries'
import { queryKeys } from '../../api/queryKeys'
import { searchHosts } from '../../api/users'
import { searchVisitors } from '../../api/visitors'
import { AsyncCombobox } from '../../components/ui/AsyncCombobox'
import { DataLine } from '../../components/ui/DataLine'
import { HighlightMatch } from '../../components/ui/HighlightMatch'
import { PhoneNumber } from '../../components/ui/PhoneLink'
import { Select } from '../../components/ui/Select'
import { compareDepartmentNames, useDepartmentName } from '../../i18n/departmentName'
import { useLanguage } from '../../i18n/useLanguage'
import type { DepartmentRef, Host, Visitor } from '../../types/api'

const VISITOR_SUGGESTIONS = 10

interface PickerProps<T> {
  value: T | null
  onChange: (value: T | null) => void
}

/**
 * Typeahead over the caller's visitors (GET /visitors?q, scoped by the server, §7.5). The
 * part of each suggestion that matches the typed text is highlighted, so a match on the
 * company or email is visible too. The placeholder says what to type (the field has no hint).
 */
export function VisitorPicker({ value, onChange, placeholder }: PickerProps<Visitor> & { placeholder?: string }) {
  const { t } = useTranslation('visits')
  return (
    <AsyncCombobox<Visitor>
      variant="search"
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      queryKey={(q) => queryKeys.visitors.search({ q, page_size: VISITOR_SUGGESTIONS })}
      fetchOptions={async (q, signal) => (await searchVisitors({ q, page_size: VISITOR_SUGGESTIONS }, { signal })).items}
      minQueryLength={2}
      getOptionKey={(visitor) => visitor.id}
      getOptionLabel={(visitor) => visitor.full_name}
      renderOption={(visitor, query) => {
        const details: ReactNode[] = []
        if (visitor.company_name) details.push(<HighlightMatch text={visitor.company_name} query={query} />)
        if (visitor.email) details.push(<HighlightMatch text={visitor.email} query={query} />)
        if (visitor.phone)
          details.push(
            <PhoneNumber>
              <HighlightMatch text={visitor.phone} query={query} />
            </PhoneNumber>,
          )
        return (
          <span className="flex flex-col">
            <span className="font-medium">
              <HighlightMatch text={visitor.full_name} query={query} />
            </span>
            {/* Each detail isolated, so an Arabic company beside an Arabic name keeps its place in an English list. */}
            <span className="text-xs wrap-anywhere text-fg-muted">{details.length === 0 ? t('pickers.noContactDetails') : <DataLine items={details} />}</span>
          </span>
        )
      }}
      emptyMessage={t('pickers.noMatchingVisitor')}
    />
  )
}

/**
 * Typeahead over active hosts (GET /users/hosts); a click lists them all. `placeholder` names the
 * empty state where no host is a choice of its own (the history's filter: "All hosts").
 */
export function HostPicker({ value, onChange, placeholder }: PickerProps<Host> & { placeholder?: string }) {
  const { t } = useTranslation('visits')
  const departmentName = useDepartmentName()
  return (
    <AsyncCombobox<Host>
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      queryKey={(q) => queryKeys.users.hosts({ q })}
      fetchOptions={(q, signal) => searchHosts(q ? { q } : {}, { signal })}
      getOptionKey={(host) => host.id}
      getOptionLabel={(host) => host.full_name}
      renderOption={(host, query) => (
        <span className="flex flex-col">
          <span className="font-medium">
            <HighlightMatch text={host.full_name} query={query} />
          </span>
          {(host.department || host.phone) && (
            <span className="text-xs text-fg-muted">
              <DataLine items={[departmentName(host.department), host.phone && <PhoneNumber key="phone">{host.phone}</PhoneNumber>]} />
            </span>
          )}
        </span>
      )}
      emptyMessage={t('pickers.noHost')}
    />
  )
}

export interface DepartmentSelectProps {
  /** '' = no department. */
  value: string
  onChange: (departmentId: string) => void
  /**
   * A department to offer even when it is not in the active list (the visit's current
   * department, or the host's while the list loads), so the current value is a visible option.
   */
  current?: DepartmentRef | null
  /** Offer "No department" (default). Off where the server would not honour it (see inviteDepartmentChoice). */
  allowNone?: boolean
  /**
   * Label `current` "(inactive)" once the active departments have loaded without it: a user
   * keeps a department that was deactivated, and the form says so (the server refuses only a
   * change to an inactive one). Off where `current` stands in while the list loads.
   */
  markInactive?: boolean
}

/**
 * Active departments (GET /departments) sorted by the name the UI shows, optionally "No
 * department", plus `current` when it is not among them. One select for visits, walk-ins and
 * user accounts. Use inside a `Field`.
 */
export function DepartmentSelect({ value, onChange, current, allowNone = true, markInactive = false }: DepartmentSelectProps) {
  const { t } = useTranslation('visits')
  const { language } = useLanguage()
  const departmentName = useDepartmentName()
  const departments = useActiveDepartments()
  const options: { department: DepartmentRef; inactive: boolean }[] = (departments.data ?? [])
    .filter((department) => department.is_active)
    .map((department) => ({ department, inactive: false }))
  if (current && !options.some((option) => option.department.id === current.id)) {
    options.push({ department: current, inactive: markInactive && departments.data !== undefined })
  }
  const byName = compareDepartmentNames(language)
  options.sort((a, b) => byName(a.department, b.department))

  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)} aria-busy={departments.isPending || undefined}>
      {allowNone && <option value="">{t('pickers.noDepartment')}</option>}
      {options.map(({ department, inactive }) => (
        <option key={department.id} value={department.id}>
          {inactive ? t('pickers.inactiveDepartment', { name: departmentName(department) }) : departmentName(department)}
        </option>
      ))}
    </Select>
  )
}

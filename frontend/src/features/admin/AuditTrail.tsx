import { CalendarSearch, FilterX, ScrollText, SearchX } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { DateRangeFields } from '../../components/ui/DateRangeFields'
import { EmptyState } from '../../components/ui/EmptyState'
import { Field } from '../../components/ui/Field'
import { FilterPanel } from '../../components/ui/FilterPanel'
import { Input } from '../../components/ui/Input'
import { Pagination } from '../../components/ui/Pagination'
import { PageSpinner } from '../../components/ui/Spinner'
import { Select } from '../../components/ui/Select'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { MetaLine } from '../../components/ui/MetaLine'
import { PageHeader } from '../../components/ui/PageHeader'
import { useSearchInput } from '../../hooks/useSearchInput'
import { pageParamValue, readPageParam, useUrlParams } from '../../hooks/useUrlParams'
import type { Me } from '../../types/api'
import { dateRangeError, dateRangeFact } from '../../utils/dateRange'
import { ActorFilter } from './ActorFilter'
import { AuditEventList } from './AuditEventList'
import {
  activeAuditFilterCount,
  AUDIT_PAGE_SIZE,
  auditFilterChanges,
  auditListParams,
  EMPTY_AUDIT_FILTERS,
  entityIdError,
  readAuditFilters,
  type AuditFilters,
} from './auditFilters'
import { AUDIT_ACTION_GROUPS, auditActionLabel, auditEntityLabel, companyAuditEntityTypes, KNOWN_AUDIT_ACTIONS } from './auditLabels'
import { useAuditLogs } from './queries'

export interface AuditTrailProps {
  me: Me
}

/**
 * The audit log (D-13): the append-only record, filterable and paged, newest first, under a header
 * that counts the events the filters match. Every filter and the page live in the URL; the actor
 * is in it by ID only (see ActorFilter). Times are the company's (`me.company.timezone`).
 */
export function AuditTrail({ me }: AuditTrailProps) {
  const { t } = useTranslation('admin')
  const [params, updateParams] = useUrlParams()
  const filters = readAuditFilters(params)
  const page = readPageParam(params)
  const applyFilters = (changes: Partial<AuditFilters>) => updateParams(auditFilterChanges(changes))
  const entityInput = useSearchInput(filters.entityId ?? '', (value) => {
    if (!entityIdError(value)) applyFilters({ entityId: value ? value.toLowerCase() : null })
  })
  const [entityTouched, setEntityTouched] = useState(false)
  const rangeError = dateRangeError(filters.from, filters.to)
  const listParams = auditListParams(filters, page)
  const logs = useAuditLogs(listParams)

  const timeZone = me.company.timezone
  const activeCount = activeAuditFilterCount(filters)
  const data = listParams ? logs.data : undefined
  const entityError = entityTouched ? entityIdError(entityInput.text) : null
  const clearFilters = () => {
    entityInput.clear()
    setEntityTouched(false)
    applyFilters(EMPTY_AUDIT_FILTERS)
  }
  const unknownAction = filters.action && !KNOWN_AUDIT_ACTIONS.includes(filters.action) ? filters.action : null
  const entityTypes = companyAuditEntityTypes()
  // A type from a link that the filter does not offer (a newer server's, the platform's own) still shows as chosen.
  const unknownEntityType = filters.entityType && !entityTypes.some(([entityType]) => entityType === filters.entityType) ? filters.entityType : null

  return (
    <>
      <PageHeader
        title={t('audit.title')}
        // The view as facts, as the visit history's: how many events it holds and the dates it covers,
        // read back in the app's format (the date inputs show the browser's).
        meta={
          data && !logs.isPlaceholderData ? (
            <MetaLine
              stackOnPhones
              items={[
                <span key="total" className="tabular-nums">
                  {t('audit.total', { count: data.total })}
                </span>,
                !rangeError && dateRangeFact(filters.from, filters.to),
              ]}
            />
          ) : undefined
        }
      />
      <FilterPanel activeCount={activeCount}>
        {/* Two rows of three from xl (two columns from md): "Clear filters" takes the free cell after
            "Record ID", at the row's end, as in the history's panel, instead of a row of its own. */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <Field label={t('audit.filters.event')}>
            <Select value={filters.action ?? ''} onChange={(event) => applyFilters({ action: event.target.value || null })}>
              <option value="">{t('audit.filters.anyEvent')}</option>
              {unknownAction && <option value={unknownAction}>{auditActionLabel(unknownAction)}</option>}
              {AUDIT_ACTION_GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {Object.entries(group.actions).map(([action, label]) => (
                    <option key={action} value={action}>
                      {label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field label={t('audit.filters.performedBy')}>
            <ActorFilter value={filters.actorId} onChange={(actorId) => applyFilters({ actorId })} />
          </Field>
          <DateRangeFields legend={t('audit.filters.date')} from={filters.from} to={filters.to} error={rangeError} onChange={(range) => applyFilters(range)} />
          <Field label={t('audit.filters.recordType')}>
            <Select value={filters.entityType ?? ''} onChange={(event) => applyFilters({ entityType: event.target.value || null })}>
              <option value="">{t('audit.filters.allRecords')}</option>
              {unknownEntityType && <option value={unknownEntityType}>{auditEntityLabel(unknownEntityType)}</option>}
              {entityTypes.map(([entityType, label]) => (
                <option key={entityType} value={entityType}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('audit.filters.recordId')} error={entityError ?? undefined}>
            <Input
              dir="ltr"
              value={entityInput.text}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              onChange={(event) => entityInput.setText(event.target.value)}
              onBlur={() => {
                setEntityTouched(true)
                entityInput.commitNow()
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  setEntityTouched(true)
                  entityInput.commitNow()
                }
              }}
            />
          </Field>
          <div className="flex items-end justify-end">
            <Button variant="ghost" icon={<FilterX aria-hidden="true" />} disabled={activeCount === 0} focusableWhenDisabled onClick={clearFilters}>
              {t('audit.filters.clear')}
            </Button>
          </div>
        </div>
      </FilterPanel>

      <p role="status" className="sr-only">
        {data ? t('audit.found', { count: data.total }) : ''}
      </p>

      {rangeError ? (
        <EmptyState icon={CalendarSearch} title={t('audit.checkDates')} description={rangeError} />
      ) : logs.isError ? (
        <LoadErrorAlert title={t('audit.loadError')} error={logs.error} onRetry={() => void logs.refetch()} />
      ) : !data ? (
        <PageSpinner label={t('audit.loading')} />
      ) : data.items.length === 0 ? (
        data.total > 0 ? (
          <EmptyState
            icon={ScrollText}
            title={t('audit.empty.pageTitle')}
            action={
              <Button variant="secondary" onClick={() => updateParams({ page: null })}>
                {t('audit.empty.firstPage')}
              </Button>
            }
          />
        ) : activeCount > 0 ? (
          <EmptyState
            icon={SearchX}
            title={t('audit.empty.filteredTitle')}
            action={
              <Button variant="secondary" onClick={clearFilters}>
                {t('audit.filters.clear')}
              </Button>
            }
          />
        ) : (
          <EmptyState icon={ScrollText} title={t('audit.empty.title')} />
        )
      ) : (
        <div aria-busy={logs.isPlaceholderData || undefined} className={logs.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}>
          <AuditEventList events={data.items} timeZone={timeZone} />
          <Pagination
            page={page}
            pageSize={AUDIT_PAGE_SIZE}
            total={data.total}
            label={t('audit.pagesLabel')}
            onPageChange={(next) => updateParams({ page: pageParamValue(next) })}
          />
        </div>
      )}
    </>
  )
}

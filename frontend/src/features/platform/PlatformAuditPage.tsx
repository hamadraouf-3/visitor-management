import { FilterX, ScrollText, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { MetaLine } from '../../components/ui/MetaLine'
import { PageHeader } from '../../components/ui/PageHeader'
import { Pagination } from '../../components/ui/Pagination'
import { Select } from '../../components/ui/Select'
import { PageSpinner } from '../../components/ui/Spinner'
import { pageParamValue, readPageParam, readUuidParam, useUrlParams } from '../../hooks/useUrlParams'
import { companyDisplayName } from '../../i18n/session'
import { useCompanyName, useLanguage } from '../../i18n/useLanguage'
import { paths } from '../../paths'
import type { PlatformAuditLog, PlatformAuditLogListParams } from '../../types/api'
import { AuditEventList } from '../admin/AuditEventList'
import { auditActionLabel } from '../admin/auditLabels'
import { platformTimeZone } from './companyFilters'
import { companiesOfUserEvents, PLATFORM_AUDIT_ACTIONS } from './platformAudit'
import { useCompanyAdminNames, usePlatformAuditLogs, usePlatformCompanyName } from './queries'

const PAGE_SIZE = 50

const PARAM = { company: 'company', action: 'action', page: 'page' } as const

/** The company filter's chip: the company's name (looked up by ID) and a button that drops the filter. */
function CompanyFilterChip({ companyId, onClear }: { companyId: string; onClear: () => void }) {
  const { t } = useTranslation('platform')
  const company = usePlatformCompanyName(companyId)
  const name = useCompanyName(company.data)
  return (
    <span className="inline-flex min-h-11 max-w-full items-center gap-1 rounded-control border border-accent-border bg-accent-surface ps-3 text-sm font-medium text-accent-text">
      <span className="min-w-0 truncate">{t('audit.filters.company', { name: name || companyId })}</span>
      {/* 44 px in both directions, the chip's whole end (it was 36 px: UX review L1). */}
      <button
        type="button"
        onClick={onClear}
        data-clear-company=""
        className="flex size-11 shrink-0 items-center justify-center rounded-control hover:bg-accent-text/10"
      >
        <X aria-hidden="true" className="size-4" />
        <span className="sr-only">{t('audit.filters.clearCompany')}</span>
      </button>
    </span>
  )
}

/**
 * /platform/audit: the platform's own trail (B11-4), newest first, filterable by event and by
 * company (`?company=` from a company's page), each row naming the company it concerns.
 */
export function PlatformAuditPage() {
  const { t } = useTranslation('platform')
  const { language } = useLanguage()
  const [params, updateParams] = useUrlParams()
  const companyId = readUuidParam(params, PARAM.company)
  const rawAction = params.get(PARAM.action)
  const action = rawAction && (PLATFORM_AUDIT_ACTIONS as readonly string[]).includes(rawAction) ? rawAction : null
  const page = readPageParam(params)
  const listParams: PlatformAuditLogListParams = { page, page_size: PAGE_SIZE }
  if (companyId) listParams.company_id = companyId
  if (action) listParams.action = action
  const logs = usePlatformAuditLogs(listParams)
  const data = logs.data
  const filtered = companyId !== null || action !== null
  // Which administrator a row is about: asked of the companies whose rows on this page concern a user, no others.
  const adminNames = useCompanyAdminNames(companiesOfUserEvents(data?.items ?? []))

  return (
    <>
      <PageHeader
        title={t('audit.title')}
        meta={
          data && !logs.isPlaceholderData ? (
            <MetaLine items={[<span key="total" className="tabular-nums">{t('audit.total', { count: data.total })}</span>]} />
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <Select
          aria-label={t('audit.filters.action')}
          value={action ?? ''}
          onChange={(event) => updateParams({ [PARAM.action]: event.target.value || null, [PARAM.page]: null })}
          className="sm:w-80"
        >
          <option value="">{t('audit.filters.allActions')}</option>
          {PLATFORM_AUDIT_ACTIONS.map((code) => (
            <option key={code} value={code}>
              {auditActionLabel(code)}
            </option>
          ))}
        </Select>
        {companyId && <CompanyFilterChip companyId={companyId} onClear={() => updateParams({ [PARAM.company]: null, [PARAM.page]: null })} />}
      </div>
      {logs.isError ? (
        <LoadErrorAlert title={t('audit.loadError')} error={logs.error} onRetry={() => void logs.refetch()} />
      ) : !data ? (
        <PageSpinner />
      ) : data.items.length === 0 ? (
        <EmptyState
          icon={filtered ? FilterX : ScrollText}
          title={filtered ? t('audit.filteredEmpty') : t('audit.empty')}
          action={
            filtered ? (
              <Button variant="secondary" onClick={() => updateParams({ [PARAM.company]: null, [PARAM.action]: null, [PARAM.page]: null })}>
                {t('companies.empty.clear')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          <AuditEventList<PlatformAuditLog>
            events={data.items}
            timeZone={platformTimeZone()}
            label={t('audit.listLabel')}
            entityLinks={false}
            entityName={(log) => (log.entity_type === 'user' && log.entity_id ? (adminNames.get(log.entity_id) ?? null) : null)}
            companyHeader={t('audit.company')}
            renderCompany={(log) =>
              log.company ? (
                // At least 24 px tall, 44 px on touch screens without changing the line height (it was 18 px: UX review L1).
                <Link
                  to={paths.platformCompany(log.company.id)}
                  className="relative inline-flex min-h-6 items-center font-medium text-accent-text hover:underline pointer-coarse:-my-3 pointer-coarse:py-3"
                >
                  {companyDisplayName(log.company, language)}
                </Link>
              ) : (
                <span className="text-fg-muted">{t('audit.noCompany')}</span>
              )
            }
          />
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={data.total}
            label={t('audit.pagesLabel')}
            onPageChange={(next) => updateParams({ [PARAM.page]: pageParamValue(next) })}
          />
        </div>
      )}
    </>
  )
}

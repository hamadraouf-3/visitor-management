import type { TFunction } from 'i18next'
import { Building2, ChevronRight, Plus, SearchX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Button, ButtonLink } from '../../components/ui/Button'
import { CellStack } from '../../components/ui/CellStack'
import { EmptyState } from '../../components/ui/EmptyState'
import { ListPanel } from '../../components/ui/ListPanel'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { MetaLine } from '../../components/ui/MetaLine'
import { PageHeader } from '../../components/ui/PageHeader'
import { Pagination } from '../../components/ui/Pagination'
import { SearchField } from '../../components/ui/SearchField'
import { Select } from '../../components/ui/Select'
import { Table, type TableColumn } from '../../components/ui/Table'
import { tableRowLinkProps } from '../../components/ui/tableStyles'
import { useSearchInput } from '../../hooks/useSearchInput'
import { pageParamValue, readPageParam, useUrlParams } from '../../hooks/useUrlParams'
import { useLanguage } from '../../i18n/useLanguage'
import { companyDisplayName } from '../../i18n/session'
import type { Language } from '../../i18n'
import { paths } from '../../paths'
import type { PlatformCompany } from '../../types/api'
import { cn } from '../../utils/cn'
import { formatDate } from '../../utils/datetime'
import { formatCount } from '../../utils/number'
import {
  COMPANIES_PAGE_SIZE,
  COMPANY_STATUS_FILTER_LABELS,
  COMPANY_STATUS_FILTERS,
  companyFilterChanges,
  companyListParams,
  platformTimeZone,
  readCompanyFilters,
  type CompanyFilters,
} from './companyFilters'
import { CompanyLogoTile } from './CompanyLogoTile'
import { CompanyStatusBadge } from './CompanyStatusBadge'
import { usePlatformCompanies } from './queries'

const STACK_BELOW = 'xl'

/*
 * The columns' shares of the table from `xl` (fixed layout). The created date takes what a whole Arabic
 * date needs on one line at 1280 px («الثلاثاء، 13 تشرين الأول 2026», about 190 px: at 15 % it broke
 * after the weekday, UX review L16), and "Active users" what its Arabic header needs; the company
 * keeps the rest.
 */
function companyColumns(t: TFunction<'platform'>, language: Language, timeZone: string): TableColumn<PlatformCompany>[] {
  const rowLink = tableRowLinkProps(STACK_BELOW)
  return [
    {
      id: 'company',
      header: t('companies.columns.company'),
      primary: true,
      headerClassName: 'xl:w-[31%]',
      className: 'xl:align-middle',
      cell: (company) => (
        <CellStack
          // The company's logo (Phase 12), else the building tile.
          leading={<CompanyLogoTile company={company} />}
          primary={
            <Link
              to={paths.platformCompany(company.id)}
              {...rowLink}
              className={cn('font-semibold break-words text-accent-text hover:underline', rowLink.className)}
            >
              {companyDisplayName(company, language)}
            </Link>
          }
          secondary={
            <span dir="ltr" className="font-normal">
              {company.slug}
            </span>
          }
        />
      ),
    },
    {
      id: 'status',
      header: t('companies.columns.status'),
      headerClassName: 'xl:w-[12%]',
      className: 'xl:align-middle',
      cell: (company) => <CompanyStatusBadge company={company} />,
    },
    {
      id: 'users',
      header: t('companies.columns.users'),
      headerClassName: 'xl:w-[15%]',
      className: 'xl:align-middle',
      cell: (company) => <span className="font-numeric text-[0.9375rem] font-medium text-fg tabular-nums">{formatCount(company.counts.active_users)}</span>,
    },
    {
      id: 'visits',
      header: t('companies.columns.visits'),
      headerClassName: 'xl:w-[14%]',
      className: 'xl:align-middle',
      cell: (company) => (
        <span className="font-numeric text-[0.9375rem] font-medium text-fg tabular-nums">{formatCount(company.counts.visits_last_30_days)}</span>
      ),
    },
    {
      id: 'created',
      header: t('companies.columns.created'),
      headerClassName: 'xl:w-[23%]',
      className: 'xl:align-middle',
      cell: (company) => (
        <span data-company-created="" className="text-fg-secondary">
          {formatDate(company.created_at, timeZone)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: t('companies.columns.actions'),
      headerHidden: true,
      stacked: 'hidden',
      align: 'end',
      headerClassName: 'xl:w-[5%]',
      className: 'xl:align-middle',
      cell: () => <ChevronRight aria-hidden="true" className="mirror-rtl ms-auto size-5 text-fg-muted" />,
    },
  ]
}

/**
 * /platform/companies: every company, searchable by name, Arabic name or slug and filtered by state
 * (in the URL; the search text in the history entry's state), with each one's two aggregates
 * (B11-2) and "Add company".
 */
export function CompaniesPage() {
  const { t } = useTranslation('platform')
  const { language } = useLanguage()
  const [params, updateParams] = useUrlParams()
  const filters = readCompanyFilters(params)
  const page = readPageParam(params)
  const companies = usePlatformCompanies(companyListParams(filters, page))
  const applyFilters = (changes: Partial<CompanyFilters>) => updateParams(companyFilterChanges(changes))
  const search = useSearchInput(filters.q, (q) => applyFilters({ q }))

  const data = companies.data
  const filtered = filters.q !== '' || filters.status !== 'all'
  const addCompany = (
    <ButtonLink to={paths.platformNewCompany} variant="primary" icon={<Plus aria-hidden="true" className="size-5" />}>
      {t('companies.add')}
    </ButtonLink>
  )

  return (
    <>
      <PageHeader
        title={t('companies.title')}
        meta={
          data && !companies.isPlaceholderData ? (
            <MetaLine items={[<span key="total" className="tabular-nums">{t('companies.total', { count: data.total })}</span>]} />
          ) : undefined
        }
        actions={addCompany}
        mobileActions={addCompany}
      />
      <ListPanel
        frameFrom={STACK_BELOW}
        toolbar={
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_16rem] sm:items-center">
            <SearchField
              label={t('companies.search.label')}
              labelHidden
              placeholder={t('companies.search.placeholder')}
              value={search.text}
              onValueChange={search.setText}
              onSubmit={search.commitNow}
              onClear={search.clear}
              className="min-w-0 xl:max-w-md"
            />
            <Select
              aria-label={t('companies.statusFilter.label')}
              value={filters.status}
              onChange={(event) => applyFilters({ status: COMPANY_STATUS_FILTERS.find((status) => status === event.target.value) ?? 'all' })}
            >
              {COMPANY_STATUS_FILTERS.map((status) => (
                <option key={status} value={status}>
                  {COMPANY_STATUS_FILTER_LABELS[status]}
                </option>
              ))}
            </Select>
          </div>
        }
        footer={
          !companies.isError &&
          data &&
          data.total > 0 && (
            <Pagination
              page={page}
              pageSize={COMPANIES_PAGE_SIZE}
              total={data.total}
              label={t('companies.pagesLabel')}
              onPageChange={(next) => updateParams({ page: pageParamValue(next) })}
            />
          )
        }
      >
        {companies.isError ? (
          <LoadErrorAlert title={t('companies.loadError')} error={companies.error} onRetry={() => void companies.refetch()} />
        ) : (
          <Table
            columns={companyColumns(t, language, platformTimeZone())}
            rows={data?.items ?? []}
            getRowKey={(company) => company.id}
            caption={t('companies.title')}
            loading={companies.isPending || companies.isPlaceholderData}
            stackBelow={STACK_BELOW}
            layout="fixed-xl"
            framed={false}
            empty={
              filtered ? (
                <EmptyState
                  icon={SearchX}
                  title={t('companies.empty.filteredTitle')}
                  action={
                    <Button
                      variant="secondary"
                      onClick={() => {
                        search.clear()
                        applyFilters({ q: '', status: 'all' })
                      }}
                    >
                      {t('companies.empty.clear')}
                    </Button>
                  }
                />
              ) : (
                <EmptyState icon={Building2} title={t('companies.empty.title')} action={addCompany} />
              )
            }
          />
        )}
      </ListPanel>
    </>
  )
}

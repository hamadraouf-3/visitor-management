import { CalendarRange, Printer } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/useAuth'
import { PrintSheetHeader } from '../../components/print/PrintSheetHeader'
import { Alert } from '../../components/ui/Alert'
import { ApiErrorMessage } from '../../components/ui/ApiErrorMessage'
import { Button } from '../../components/ui/Button'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { MetaLine } from '../../components/ui/MetaLine'
import { PageHeader } from '../../components/ui/PageHeader'
import { PageSpinner } from '../../components/ui/Spinner'
import { useNow } from '../../hooks/useNow'
import { useUrlParams } from '../../hooks/useUrlParams'
import { i18n } from '../../i18n'
import { useCompanyName } from '../../i18n/useLanguage'
import { cn } from '../../utils/cn'
import { companyToday, formatDateKey } from '../../utils/datetime'
import { formatCount } from '../../utils/number'
import { useReportSummary } from './queries'
import { ReportBody } from './ReportBody'
import { ReportRangeControls } from './ReportRangeControls'
import { rangeDays, readReportRange, reportRangeChanges, reportSummaryParams, type ReportRange } from './reportRange'

/** "Mon, 7 Sep 2026 to Tue, 6 Oct 2026 (30 days)." for the printed sheet (one catalog sentence, so no language glues words around dates). */
function periodSentence(from: string, to: string): string {
  return i18n.t('period', { ns: 'reports', from: formatDateKey(from), to: formatDateKey(to), count: rangeDays({ from, to }) })
}

/** The period as facts under the title: "Mon, 7 Sep 2026 – Tue, 6 Oct 2026 · 30 days". */
function PeriodMeta({ range }: { range: ReportRange }) {
  const { t } = useTranslation('reports')
  const days = rangeDays(range)
  return (
    <MetaLine
      stackOnPhones
      items={[
        <>
          <CalendarRange aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
          <span>{t('meta.range', { from: formatDateKey(range.from), to: formatDateKey(range.to) })}</span>
        </>,
        t('meta.days', { count: days, formatted: formatCount(days) }),
      ]}
    />
  )
}

/**
 * /reports (§10; management and administrators): visit volumes, no-show rate, average duration,
 * busiest days and hours, departments and top hosts for a company-local date range (default the
 * last 30 days, at most 366), in direction C's dashboard style. The range lives in the URL; the
 * header reads it back as facts. The page prints without its controls, under a header that names
 * the company, the period, when the figures were generated and who printed them.
 */
export function ReportsPage() {
  const { t } = useTranslation('reports')
  const { me } = useAuth()
  const now = useNow()
  const [params, updateParams] = useUrlParams()
  const timeZone = me?.company.timezone ?? 'UTC'
  const today = companyToday(timeZone, now)
  const range = readReportRange(params, today)
  const report = useReportSummary(reportSummaryParams(range))
  const companyName = useCompanyName(me?.company)

  if (!me) return null
  const data = report.data

  return (
    <>
      <PageHeader
        className="print:hidden"
        title={t('title')}
        meta={<PeriodMeta range={range} />}
        actionsBesideTitle
        actions={
          <Button variant="secondary" icon={<Printer aria-hidden="true" />} disabled={!data} onClick={() => window.print()}>
            {t('print')}
          </Button>
        }
      />

      <section aria-label={t('range.label')} className="mb-6 rounded-card border border-border bg-surface p-4 print:hidden">
        <ReportRangeControls range={range} today={today} onChange={(next) => updateParams(reportRangeChanges(next, today))} />
      </section>

      {report.isError && !data ? (
        <LoadErrorAlert title={t('loadError')} error={report.error} onRetry={() => void report.refetch()} />
      ) : !data ? (
        <PageSpinner label={t('loading')} />
      ) : (
        <>
          {report.isError && (
            <Alert tone="danger" className="mb-4 print:hidden" title={t('periodLoadError')}>
              <ApiErrorMessage error={report.error} /> {t('previousPeriodShown')}
            </Alert>
          )}
          <div aria-busy={report.isPlaceholderData || undefined} className={cn(report.isPlaceholderData && 'opacity-60 transition-opacity')}>
            <PrintSheetHeader
              paperOnly
              companyName={companyName}
              title={t('printTitle')}
              generatedAt={report.dataUpdatedAt}
              timeZone={data.timezone}
              lines={periodSentence(data.date_from, data.date_to)}
              printedBy={me.user.full_name}
              className="mb-4"
            />
            <ReportBody report={data} now={now} />
          </div>
        </>
      )}
    </>
  )
}

import { ChartColumn } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '../../components/ui/EmptyState'
import type { ReportSummary } from '../../types/api'
import { companyToday } from '../../utils/datetime'
import { formatCount } from '../../utils/number'
import { BarChart } from './charts/BarChart'
import { ChartFigure } from './charts/ChartFigure'
import { ChartLegend } from './charts/ChartLegend'
import { ColumnChart } from './charts/ColumnChart'
import { PRINT_HALF_CHART_WIDTH } from './charts/useChartSize'
import {
  dailySummaryText,
  departmentBars,
  departmentRows,
  fillDailySeries,
  fillHourlySeries,
  formatMean,
  hourStartLabel,
  summarizeSeries,
  type ChartDatum,
} from './chartData'
import { ReportKpis } from './ReportKpis'
import { checkIns, visits } from './reportTexts'
import { TopHosts } from './TopHosts'

/** Above this many days the daily chart is a line: columns would be hairlines. */
const MAX_DAILY_COLUMNS = 62
/** Chart heights on paper: the report is two A4 or Letter pages with eight or so departments. */
const PRINT_DAILY_HEIGHT = 180
const PRINT_HOURLY_HEIGHT = 170

function tableRows(series: readonly ChartDatum[], format: (value: number) => string) {
  return series.map((datum) => ({ key: datum.key, label: datum.label, value: format(datum.value) }))
}

export interface ReportBodyProps {
  report: ReportSummary
  /** For today's company-local date (the daily chart's mark still under way). */
  now: number
}

/**
 * The report for one period (direction C): the key figures, visits booked per day, by department,
 * check-ins by hour, top hosts. "Visits" are the visits booked for the period (§8.1
 * `totals.visits`, B57-32): every status, cancelled ones and today's visitors still expected
 * included, which the dark tile's outcomes show, so the number is not read as "people who came"
 * (unique visitors are). Today is drawn as still under way and never named the busiest day.
 *
 * Each chart has a title, its headline figure and its data table; its summary sentence is its
 * accessible description only (no notes on screen, decision 3 of the brand pass).
 *
 * On paper (FY-10) it takes two A4 or Letter pages: the tiles form one compact row, the daily
 * chart takes the paper's width at a shorter height, the department and hour charts stand side
 * by side, and the top hosts follow, each card kept whole.
 */
export function ReportBody({ report, now }: ReportBodyProps) {
  const { t } = useTranslation('reports')
  const { totals } = report
  const daily = fillDailySeries(report.visits_per_day, report.date_from, report.date_to, companyToday(report.timezone, now))
  const hourly = fillHourlySeries(report.check_ins_by_hour)
  const departments = departmentBars(report.by_department)
  const dailySummary = summarizeSeries(daily)
  const hourlySummary = summarizeSeries(hourly)
  const busiestDepartment = departments[0]
  const dailyAsLine = daily.length > MAX_DAILY_COLUMNS

  return (
    <div className="flex flex-col gap-6 print:gap-3">
      <section aria-labelledby="report-summary">
        <h2 id="report-summary" className="sr-only">
          {t('summary.title')}
        </h2>
        <ReportKpis report={report} />
      </section>

      {totals.visits === 0 ? (
        <EmptyState icon={ChartColumn} title={t('empty.title')} />
      ) : (
        <>
          <ChartFigure
            title={t('charts.daily.title')}
            summary={dailySummaryText(daily, visits)}
            figure={{ label: t('charts.daily.average'), value: formatMean(dailySummary.total, daily.length) }}
            legend={
              // While the period includes today: its mark is drawn as still under way, and named.
              dailySummary.partial && (
                <ChartLegend
                  items={[
                    { label: t('charts.daily.legendDays'), mark: dailyAsLine ? 'line' : 'column' },
                    { label: t('charts.daily.legendToday'), mark: dailyAsLine ? 'hollow' : 'hatched' },
                  ]}
                />
              )
            }
            table={{ columns: [t('charts.daily.columnDay'), t('charts.daily.columnVisits')], rows: tableRows(daily, formatCount) }}
          >
            <ColumnChart
              data={daily}
              formatValue={visits}
              label={t('charts.daily.title')}
              variant={dailyAsLine ? 'line' : 'columns'}
              axisLabelWidth={56}
              printHeight={PRINT_DAILY_HEIGHT}
            />
          </ChartFigure>

          {/* Side by side from xl on screen, and on paper, where each is drawn at half its width. */}
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-2 print:grid-cols-2 print:gap-3">
            <ChartFigure
              title={t('charts.departments.title')}
              summary={
                busiestDepartment
                  ? t('charts.departments.busiest', { department: busiestDepartment.label, visits: visits(busiestDepartment.value) })
                  : t('charts.departments.none')
              }
              table={{
                columns: [t('charts.departments.columnDepartment'), t('charts.departments.columnVisits')],
                rows: tableRows(departmentRows(report.by_department), formatCount),
              }}
            >
              {departments.length > 0 ? (
                <BarChart data={departments} formatValue={visits} label={t('charts.departments.title')} printWidth={PRINT_HALF_CHART_WIDTH} />
              ) : (
                <p className="text-sm text-fg-muted">{t('charts.departments.noDepartment')}</p>
              )}
            </ChartFigure>

            <ChartFigure
              title={t('charts.hourly.title')}
              summary={
                hourlySummary.peak
                  ? t('charts.hourly.summary', { checkIns: checkIns(hourlySummary.total), hour: hourlySummary.peak.label })
                  : t('charts.hourly.none')
              }
              figure={hourlySummary.peak ? { label: t('charts.hourly.busiest'), value: hourStartLabel(Number(hourlySummary.peak.key)) } : undefined}
              table={{ columns: [t('charts.hourly.columnHour'), t('charts.hourly.columnCheckIns')], rows: tableRows(hourly, formatCount) }}
            >
              <ColumnChart
                data={hourly}
                formatValue={checkIns}
                label={t('charts.hourly.title')}
                axisLabelWidth={30}
                numericAxis
                labelEnd={false}
                printWidth={PRINT_HALF_CHART_WIDTH}
                printHeight={PRINT_HOURLY_HEIGHT}
              />
            </ChartFigure>
          </div>

          <TopHosts hosts={report.top_hosts} total={totals.visits} />
        </>
      )}
    </div>
  )
}

import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { queryKeys } from '../../api/queryKeys'
import { getReportSummary } from '../../api/reports'
import type { ReportSummaryParams } from '../../types/api'

/**
 * The report for a date range. While another range loads, the previous report stays on screen
 * (shown as busy), so the page keeps its frame instead of flashing a spinner.
 */
export function useReportSummary(params: ReportSummaryParams) {
  return useQuery({
    queryKey: queryKeys.reports.summary(params),
    queryFn: ({ signal }) => getReportSummary(params, { signal }),
    placeholderData: keepPreviousData,
  })
}

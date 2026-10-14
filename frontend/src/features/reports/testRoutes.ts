import { jsonResponse, type RouteHandler } from '../../test/api'
import type { ReportSummary } from '../../types/api'

/** An empty report for 6 Sep – 5 Oct 2026 (tests only). */
export function makeReport(overrides: Partial<ReportSummary> = {}): ReportSummary {
  return {
    date_from: '2026-09-06',
    date_to: '2026-10-05',
    timezone: 'Asia/Amman',
    totals: { visits: 0, unique_visitors: 0, checked_in: 0, checked_out: 0, no_show: 0, cancelled: 0, walk_ins: 0 },
    no_show_rate: null,
    avg_duration_seconds: null,
    visits_per_day: [],
    by_department: [],
    top_hosts: [],
    check_ins_by_hour: [],
    ...overrides,
  }
}

/** API routes /reports needs, for tests that land on it (route guards, sign-in). Spread into `mockApi({...})`. */
export function reportsRoutes(report: ReportSummary = makeReport()): Record<string, RouteHandler> {
  return { 'GET /reports/summary': () => jsonResponse(report) }
}

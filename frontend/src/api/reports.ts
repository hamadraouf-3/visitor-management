import type { ReportSummary, ReportSummaryParams } from '../types/api'
import { apiRequest, type CallOptions } from './client'

export function getReportSummary(params: ReportSummaryParams = {}, options?: CallOptions): Promise<ReportSummary> {
  return apiRequest('/reports/summary', { ...options, query: params })
}

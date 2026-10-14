import type { AuditLogListParams, AuditLogPage } from '../types/api'
import { apiRequest, type CallOptions } from './client'

/** Ordered by `seq` descending. SYSTEM_ADMIN only (D-13). */
export function listAuditLogs(params: AuditLogListParams = {}, options?: CallOptions): Promise<AuditLogPage> {
  return apiRequest('/audit-logs', { ...options, query: params })
}

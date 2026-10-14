import type {
  CheckOutStaleRequest,
  CheckOutStaleResult,
  InsideList,
  ReceptionToday,
  ScanRequest,
  ScanResult,
  Visit,
  WalkInCreate,
} from '../types/api'
import { apiRequest, type CallOptions } from './client'

/**
 * Validates a scanned pass (§6 table). Resolves (200) with `result` READY (row 9) or
 * ALREADY_CHECKED_IN (row 4, offers check-out). Rows 1–3 and 5–8 reject with an ApiError
 * (PASS_INVALID, VISIT_CANCELLED, VISIT_COMPLETED, HOST_INACTIVE, PASS_REVOKED, PASS_EXPIRED,
 * PASS_NOT_YET_VALID) whose `details` is a `ScanErrorDetails` (visit summary +
 * check_in_options; empty for PASS_INVALID).
 */
export function scanPass(body: ScanRequest, options?: CallOptions): Promise<ScanResult> {
  return apiRequest('/reception/scan', { ...options, method: 'POST', body })
}

export function getReceptionToday(options?: CallOptions): Promise<ReceptionToday> {
  return apiRequest('/reception/today', options)
}

/** All CHECKED_IN visits, any date (evacuation list). */
export function getInside(options?: CallOptions): Promise<InsideList> {
  return apiRequest('/reception/inside', options)
}

/**
 * Bulk check-out (BULK) of the CHECKED_IN visits checked in before company-local today whose
 * scheduled end has passed (B57-71), each at max(check_in_at, scheduled_end).
 */
export function checkOutStale(body: CheckOutStaleRequest, options?: CallOptions): Promise<CheckOutStaleResult> {
  return apiRequest('/reception/check-out-stale', { ...options, method: 'POST', body })
}

/** Creates the visit already CHECKED_IN (method WALK_IN). */
export function createWalkIn(body: WalkInCreate, options?: CallOptions): Promise<Visit> {
  return apiRequest('/reception/walk-ins', { ...options, method: 'POST', body })
}

import type {
  CheckInRequest,
  CheckOutRequest,
  Visit,
  VisitCancelRequest,
  VisitCreate,
  VisitCreateResult,
  VisitResendResult,
  VisitListParams,
  VisitPage,
  VisitPassResult,
  VisitUpdate,
} from '../types/api'
import { apiRequest, segment, type CallOptions } from './client'

/** Scoped: EMPLOYEE-only callers always see owned visits only (§7.5). */
export function listVisits(params: VisitListParams = {}, options?: CallOptions): Promise<VisitPage> {
  return apiRequest('/visits', { ...options, query: params })
}

/** The result carries the one-time `pass_url`; it is never retrievable later (§6). */
export function createVisit(body: VisitCreate, options?: CallOptions): Promise<VisitCreateResult> {
  return apiRequest('/visits', { ...options, method: 'POST', body })
}

export function getVisit(id: string, options?: CallOptions): Promise<Visit> {
  return apiRequest(`/visits/${segment(id)}`, options)
}

/** SCHEDULED visits only; rescheduling keeps the existing pass (D-22). */
export function updateVisit(id: string, body: VisitUpdate, options?: CallOptions): Promise<Visit> {
  return apiRequest(`/visits/${segment(id)}`, { ...options, method: 'PATCH', body })
}

export function cancelVisit(id: string, body: VisitCancelRequest = {}, options?: CallOptions): Promise<Visit> {
  return apiRequest(`/visits/${segment(id)}/cancel`, { ...options, method: 'POST', body })
}

/**
 * Rotates the pass (the previous QR stops working) and sends a new invitation (D-10); when only the
 * calendar invitation had failed (`invitation.calendar_failed`), sends that one alone, the pass kept
 * (`pass_url` null, B14-31).
 */
export function resendInvitation(id: string, options?: CallOptions): Promise<VisitResendResult> {
  return apiRequest(`/visits/${segment(id)}/invitation`, { ...options, method: 'POST' })
}

/**
 * Rotates the pass (the previous QR stops working) and returns the new one-time `pass_url`
 * without sending any email, for the host to share (contract addition B57-04).
 */
export function issueVisitPass(id: string, options?: CallOptions): Promise<VisitPassResult> {
  return apiRequest(`/visits/${segment(id)}/pass`, { ...options, method: 'POST' })
}

export function checkInVisit(id: string, body: CheckInRequest, options?: CallOptions): Promise<Visit> {
  return apiRequest(`/visits/${segment(id)}/check-in`, { ...options, method: 'POST', body })
}

export function checkOutVisit(id: string, body: CheckOutRequest, options?: CallOptions): Promise<Visit> {
  return apiRequest(`/visits/${segment(id)}/check-out`, { ...options, method: 'POST', body })
}

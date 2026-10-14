import type {
  PageParams,
  Visitor,
  VisitorCreate,
  VisitorSearchPage,
  VisitorSearchParams,
  VisitorUpdate,
  VisitPage,
} from '../types/api'
import { apiRequest, segment, type CallOptions } from './client'

/** Scoped to the caller (§7.5). */
export function searchVisitors(params: VisitorSearchParams = {}, options?: CallOptions): Promise<VisitorSearchPage> {
  return apiRequest('/visitors', { ...options, query: params })
}

export function createVisitor(body: VisitorCreate, options?: CallOptions): Promise<Visitor> {
  return apiRequest('/visitors', { ...options, method: 'POST', body })
}

export function getVisitor(id: string, options?: CallOptions): Promise<Visitor> {
  return apiRequest(`/visitors/${segment(id)}`, options)
}

/** An email change re-issues invitations for the visitor's SCHEDULED visits (D-19). */
export function updateVisitor(id: string, body: VisitorUpdate, options?: CallOptions): Promise<Visitor> {
  return apiRequest(`/visitors/${segment(id)}`, { ...options, method: 'PATCH', body })
}

/** Newest first. */
export function listVisitorVisits(id: string, params: PageParams = {}, options?: CallOptions): Promise<VisitPage> {
  return apiRequest(`/visitors/${segment(id)}/visits`, { ...options, query: params })
}

import type { TrackingAlertListParams } from '../../../types/api'

/** The alerts page (Phase 16): its tabs, its view in the address, and the request. */

export const ALERTS_PAGE_SIZE = 20

export const ALERT_SCOPES = ['active', 'day'] as const
export type AlertScope = (typeof ALERT_SCOPES)[number]

/** The view in the address: the tab (`scope`, active by default), the day (`day`, today by default) and the page. */
export const ALERTS_PARAM = { scope: 'scope', day: 'day', page: 'page' } as const

/** `GET /tracking/alerts` for the page's view; `day` null: today (the server's default). */
export function alertListParams(scope: AlertScope, day: string | null, page: number): TrackingAlertListParams {
  return scope === 'day' ? { scope: 'day', ...(day ? { day } : {}), page, page_size: ALERTS_PAGE_SIZE } : { scope: 'active', page, page_size: ALERTS_PAGE_SIZE }
}

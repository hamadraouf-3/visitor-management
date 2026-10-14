import { readDateParam, readUuidParam, type UrlParamChanges } from '../../hooks/useUrlParams'
import { i18n } from '../../i18n'
import type { AuditLogListParams } from '../../types/api'
import { dateRangeError } from '../../utils/dateRange'
import { isUuid } from '../../utils/ids'

export const AUDIT_PAGE_SIZE = 50

/** Query-string keys of the audit log page (`entity_type` / `entity_id` match the API names, so links read naturally). */
export const AUDIT_PARAM = {
  action: 'action',
  /** The actor's user ID only: the filter shows the name the server gives for it (GET /users/{id}). */
  actor: 'actor',
  entityType: 'entity_type',
  entityId: 'entity_id',
  from: 'from',
  to: 'to',
  page: 'page',
} as const

export interface AuditFilters {
  action: string | null
  /** The user ID of who performed the events. */
  actorId: string | null
  entityType: string | null
  entityId: string | null
  from: string | null
  to: string | null
}

export const EMPTY_AUDIT_FILTERS: AuditFilters = { action: null, actorId: null, entityType: null, entityId: null, from: null, to: null }

/** The shapes the backend accepts (`AuditActionFilter`, `EntityTypeFilter`); anything else is ignored. */
const ACTION_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
const ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/

function readMatching(params: URLSearchParams, key: string, pattern: RegExp): string | null {
  const raw = params.get(key)?.trim()
  return raw && pattern.test(raw) ? raw : null
}

/**
 * The filters in the URL; malformed values are ignored rather than sent. Only IDs come from the
 * URL, never a name to show for them: a link could otherwise label one user's events with
 * another user's name (the filter looks the name up, see ActorFilter).
 */
export function readAuditFilters(params: URLSearchParams): AuditFilters {
  return {
    action: readMatching(params, AUDIT_PARAM.action, ACTION_PATTERN),
    actorId: readUuidParam(params, AUDIT_PARAM.actor),
    entityType: readMatching(params, AUDIT_PARAM.entityType, ENTITY_TYPE_PATTERN),
    entityId: readUuidParam(params, AUDIT_PARAM.entityId),
    from: readDateParam(params, AUDIT_PARAM.from),
    to: readDateParam(params, AUDIT_PARAM.to),
  }
}

/** URL changes for new filter values; any change returns to the first page. */
export function auditFilterChanges(filters: Partial<AuditFilters>): UrlParamChanges {
  const changes: UrlParamChanges = { [AUDIT_PARAM.page]: null }
  if ('action' in filters) changes[AUDIT_PARAM.action] = filters.action ?? null
  if ('actorId' in filters) changes[AUDIT_PARAM.actor] = filters.actorId ?? null
  if ('entityType' in filters) changes[AUDIT_PARAM.entityType] = filters.entityType ?? null
  if ('entityId' in filters) changes[AUDIT_PARAM.entityId] = filters.entityId ?? null
  if ('from' in filters) changes[AUDIT_PARAM.from] = filters.from ?? null
  if ('to' in filters) changes[AUDIT_PARAM.to] = filters.to ?? null
  return changes
}

export function activeAuditFilterCount(filters: AuditFilters): number {
  return [filters.action, filters.actorId, filters.entityType, filters.entityId, filters.from ?? filters.to].filter((value) => value !== null).length
}

/** The message for a typed entity ID that cannot be searched for, or null. */
export function entityIdError(text: string): string | null {
  const value = text.trim()
  return value === '' || isUuid(value) ? null : i18n.t('audit.filters.recordIdError', { ns: 'admin' })
}

/**
 * GET /audit-logs parameters (§8): newest first by `seq` (the server's order), dates
 * company-local. Null while the date range is invalid (no request is made).
 */
export function auditListParams(filters: AuditFilters, page: number): AuditLogListParams | null {
  if (dateRangeError(filters.from, filters.to)) return null
  const params: AuditLogListParams = { page, page_size: AUDIT_PAGE_SIZE }
  if (filters.action) params.action = filters.action
  if (filters.actorId) params.actor_user_id = filters.actorId
  if (filters.entityType) params.entity_type = filters.entityType
  if (filters.entityId) params.entity_id = filters.entityId
  if (filters.from) params.date_from = filters.from
  if (filters.to) params.date_to = filters.to
  return params
}

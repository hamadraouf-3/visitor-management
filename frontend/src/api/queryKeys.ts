import type {
  AuditLogListParams,
  DepartmentListParams,
  EmailTemplateKind,
  HostSearchParams,
  JourneyListParams,
  PageParams,
  PlatformAuditLogListParams,
  PlatformCompanyListParams,
  ReportSummaryParams,
  TrackingAlertListParams,
  TrackingCameraListParams,
  UserListParams,
  VisitListParams,
  VisitorSearchParams,
} from '../types/api'

/**
 * TanStack Query keys for every resource. Hierarchical, so invalidating a prefix
 * (e.g. `queryKeys.visits.all`) refreshes every list and detail below it.
 */
export const queryKeys = {
  me: ['auth', 'me'] as const,

  users: {
    all: ['users'] as const,
    hosts: (params: HostSearchParams = {}) => ['users', 'hosts', params] as const,
    list: (params: UserListParams = {}) => ['users', 'list', params] as const,
    detail: (id: string) => ['users', 'detail', id] as const,
  },

  departments: {
    all: ['departments'] as const,
    list: (params: DepartmentListParams = {}) => ['departments', 'list', params] as const,
  },

  companySettings: ['company', 'settings'] as const,

  visitors: {
    all: ['visitors'] as const,
    search: (params: VisitorSearchParams = {}) => ['visitors', 'search', params] as const,
    detail: (id: string) => ['visitors', 'detail', id] as const,
    visits: (id: string, params: PageParams = {}) => ['visitors', 'detail', id, 'visits', params] as const,
  },

  visits: {
    all: ['visits'] as const,
    /** Every visit list (not the details), e.g. to refresh lists after a mutation returned the visit. */
    lists: ['visits', 'list'] as const,
    list: (params: VisitListParams = {}) => ['visits', 'list', params] as const,
    detail: (id: string) => ['visits', 'detail', id] as const,
  },

  reception: {
    all: ['reception'] as const,
    today: ['reception', 'today'] as const,
    inside: ['reception', 'inside'] as const,
  },

  dashboard: {
    employee: ['dashboard', 'employee'] as const,
    admin: ['dashboard', 'admin'] as const,
  },

  reports: {
    summary: (params: ReportSummaryParams = {}) => ['reports', 'summary', params] as const,
  },

  auditLogs: {
    list: (params: AuditLogListParams = {}) => ['audit-logs', 'list', params] as const,
  },

  /** A company's e-mail texts (Phase 11). */
  emailTemplates: {
    all: ['email-templates'] as const,
    list: ['email-templates', 'list'] as const,
    detail: (kind: EmailTemplateKind) => ['email-templates', 'detail', kind] as const,
    /** A draft's rendering (POST preview): the request body is part of the key. */
    preview: (kind: EmailTemplateKind, body: unknown) => ['email-templates', 'preview', kind, body] as const,
  },

  /** Visitor tracking (Phase 15): its status, settings, keys, cameras and the location registry. */
  tracking: {
    all: ['tracking'] as const,
    status: ['tracking', 'status'] as const,
    settings: ['tracking', 'settings'] as const,
    keys: ['tracking', 'keys'] as const,
    cameras: {
      all: ['tracking', 'cameras'] as const,
      list: (params: TrackingCameraListParams = {}) => ['tracking', 'cameras', params] as const,
    },
    locations: ['tracking', 'locations'] as const,
    /** Phase 16: the alerts, and the counts the shell polls. */
    alerts: {
      all: ['tracking', 'alerts'] as const,
      list: (params: TrackingAlertListParams = {}) => ['tracking', 'alerts', 'list', params] as const,
      summary: ['tracking', 'alerts', 'summary'] as const,
    },
  },

  /** The Visitor Journey (Phase 15): the day's journeys and one visit's. */
  journeys: {
    all: ['journeys'] as const,
    list: (params: JourneyListParams = {}) => ['journeys', 'list', params] as const,
    detail: (visitId: string) => ['journeys', 'detail', visitId] as const,
    /** Phase 16: everyone inside now, on the live map (the whole company: the map places them by building). */
    live: ['journeys', 'live'] as const,
  },

  /** A company's public identity (Phase 12), asked for by slug without a session: display data, nobody's own. */
  publicBrand: (slug: string) => ['public-brand', slug] as const,

  /**
   * The platform owner's realm (Phase 11): every key starts with 'platform', so a company session's
   * start or end leaves them alone, and a platform session's start or end touches only them.
   */
  platform: {
    all: ['platform'] as const,
    me: ['platform', 'auth', 'me'] as const,
    companies: {
      all: ['platform', 'companies'] as const,
      list: (params: PlatformCompanyListParams = {}) => ['platform', 'companies', 'list', params] as const,
      detail: (id: string) => ['platform', 'companies', 'detail', id] as const,
      admins: (id: string) => ['platform', 'companies', 'detail', id, 'admins'] as const,
      /** A company's e-mail texts as the platform owner edits them (Phase 12): the same shapes as the company's own. */
      emailTemplates: {
        all: (id: string) => ['platform', 'companies', 'detail', id, 'email-templates'] as const,
        list: (id: string) => ['platform', 'companies', 'detail', id, 'email-templates', 'list'] as const,
        detail: (id: string, kind: EmailTemplateKind) => ['platform', 'companies', 'detail', id, 'email-templates', 'detail', kind] as const,
        preview: (id: string, kind: EmailTemplateKind, body: unknown) => ['platform', 'companies', 'detail', id, 'email-templates', 'preview', kind, body] as const,
      },
    },
    /** The palette a colour would give (Phase 12, POST /platform/brand/palette): the identity page's live preview. */
    palette: (color: string) => ['platform', 'brand', 'palette', color] as const,
    auditLogs: {
      all: ['platform', 'audit-logs'] as const,
      list: (params: PlatformAuditLogListParams = {}) => ['platform', 'audit-logs', 'list', params] as const,
    },
  },
} as const

/** Whether `key` belongs to the platform owner's realm (`queryKeys.platform`). */
export function isPlatformQueryKey(key: readonly unknown[]): boolean {
  return key[0] === queryKeys.platform.all[0]
}

/** Whether `key` is the platform session check's key (`queryKeys.platform.me`). */
export function isPlatformMeQueryKey(key: readonly unknown[]): boolean {
  const me = queryKeys.platform.me
  return key.length === me.length && key.every((part, index) => part === me[index])
}

/** Whether `key` is the session check's key (`queryKeys.me`). */
export function isMeQueryKey(key: readonly unknown[]): boolean {
  return key.length === queryKeys.me.length && key.every((part, index) => part === queryKeys.me[index])
}

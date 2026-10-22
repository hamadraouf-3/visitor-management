/** Query parameter of the invite page that preselects a returning visitor ("Invite again"). */
export const INVITE_VISITOR_PARAM = 'visitor'

/**
 * Query parameters that never go into an address the app writes: the text typed into a search
 * box (`q`: names, email addresses, phone numbers) and the history's host-name hint. The browser
 * keeps every address it showed in its saved history and address-bar suggestions (and syncs
 * them) after sign-out, `replaceState` included, so on a shared device the next person could
 * read them. Pages keep these values in the history entry's state instead (`useUrlParams`), and
 * `?next=` never carries them.
 */
export const PRIVATE_PARAMS: readonly string[] = ['q', 'hostName']

/** Route paths (§10). Use these instead of string literals when linking between features. */
export const paths = {
  home: '/',
  login: '/login',
  /** A company's own sign-in page (Phase 12): the link the platform owner hands out. Also `/c/{slug}/login`. */
  companySignIn: (slug: string) => `/c/${encodeURIComponent(slug)}`,
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',
  changePassword: '/change-password',
  pass: '/pass',

  myVisits: '/visits',
  inviteVisitor: '/visits/new',
  inviteVisitorAgain: (visitorId: string) => `/visits/new?${INVITE_VISITOR_PARAM}=${encodeURIComponent(visitorId)}`,
  visit: (id: string) => `/visits/${encodeURIComponent(id)}`,

  reception: '/reception',

  visitors: '/visitors',
  visitor: (id: string) => `/visitors/${encodeURIComponent(id)}`,

  history: '/history',
  inside: '/inside',
  /** The Visitor Journey (Phase 15): the day's visits and their last inferred floor or zone. */
  journey: '/journey',
  journeyVisit: (visitId: string) => `/journey/${encodeURIComponent(visitId)}`,
  /** Tracking alerts (Phase 16): visitors seen outside their allowed areas. */
  journeyAlerts: '/journey/alerts',
  reports: '/reports',

  adminDashboard: '/admin',
  adminUsers: '/admin/users',
  adminDepartments: '/admin/departments',
  adminSettings: '/admin/settings',
  adminAudit: '/admin/audit',
  adminEmailTemplates: '/admin/email-templates',
  adminEmailTemplate: (kind: string) => `/admin/email-templates/${encodeURIComponent(kind)}`,
  /** Visitor tracking (Phase 15): the switch and thresholds, the provider's keys, the locations and the cameras. */
  adminTracking: '/admin/tracking',

  /* The platform owner's area (Phase 11): another principal, with a session of its own. */
  platform: '/platform',
  platformCompanies: '/platform/companies',
  platformLogin: '/platform/login',
  platformChangePassword: '/platform/change-password',
  platformNewCompany: '/platform/companies/new',
  platformCompany: (id: string) => `/platform/companies/${encodeURIComponent(id)}`,
  platformCompanyIdentity: (id: string) => `/platform/companies/${encodeURIComponent(id)}/identity`,
  platformCompanyEmailTemplates: (id: string) => `/platform/companies/${encodeURIComponent(id)}/email-templates`,
  platformCompanyEmailTemplate: (id: string, kind: string) => `/platform/companies/${encodeURIComponent(id)}/email-templates/${encodeURIComponent(kind)}`,
  platformAudit: '/platform/audit',
} as const

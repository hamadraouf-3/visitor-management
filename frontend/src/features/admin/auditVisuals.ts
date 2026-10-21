import {
  Ban,
  Building,
  CalendarClock,
  CalendarPlus,
  CalendarX,
  Cctv,
  CircleCheck,
  Contact,
  DoorOpen,
  KeyRound,
  LogIn,
  LogOut,
  Mail,
  MapPinned,
  PenLine,
  QrCode,
  Radar,
  RotateCcw,
  Route,
  ScanLine,
  ScrollText,
  Send,
  Settings,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  UserCheck,
  UserCog,
  UserPlus,
  UserRoundX,
  UserX,
  type LucideIcon,
} from 'lucide-react'
import type { Tone } from '../../components/ui/tones'
import type { AuditLog } from '../../types/api'
import { isFailureEvent } from './auditLabels'

/** The icon tile of an audit event: what kind of event it is, at a glance (decorative: the label says it). */
export interface AuditEventVisual {
  icon: LucideIcon
  tone: Tone
  /** The icon points the reading direction's way (signing in and out): mirrored right to left. */
  mirror?: boolean
}

const SECURITY_ACTIONS = new Set(['ACCESS_DENIED', 'CSRF_FAILED', 'RATE_LIMITED', 'AUTH_ACCOUNT_THROTTLED'])

const ACTION_VISUALS: Readonly<Record<string, AuditEventVisual>> = {
  AUTH_LOGIN_SUCCEEDED: { icon: LogIn, tone: 'neutral', mirror: true },
  AUTH_LOGOUT: { icon: LogOut, tone: 'neutral', mirror: true },
  AUTH_PASSWORD_CHANGED: { icon: KeyRound, tone: 'neutral' },
  AUTH_PASSWORD_RESET_REQUESTED: { icon: KeyRound, tone: 'neutral' },
  AUTH_PASSWORD_RESET_COMPLETED: { icon: KeyRound, tone: 'neutral' },
  USER_CREATED: { icon: UserPlus, tone: 'accent' },
  USER_UPDATED: { icon: UserCog, tone: 'accent' },
  USER_ROLES_CHANGED: { icon: UserCog, tone: 'accent' },
  USER_DEACTIVATED: { icon: UserX, tone: 'neutral' },
  USER_REACTIVATED: { icon: UserCheck, tone: 'accent' },
  DEPARTMENT_CREATED: { icon: Building, tone: 'accent' },
  DEPARTMENT_UPDATED: { icon: Building, tone: 'accent' },
  COMPANY_CREATED: { icon: Settings, tone: 'accent' },
  COMPANY_SETTINGS_UPDATED: { icon: Settings, tone: 'accent' },
  COMPANY_DEACTIVATED: { icon: Ban, tone: 'warning' },
  COMPANY_REACTIVATED: { icon: CircleCheck, tone: 'accent' },
  EMAIL_TEMPLATE_UPDATED: { icon: PenLine, tone: 'accent' },
  EMAIL_TEMPLATE_RESET: { icon: RotateCcw, tone: 'neutral' },
  EMAIL_TEMPLATE_TEST_SENT: { icon: Send, tone: 'info' },
  PLATFORM_ADMIN_CREATED: { icon: ShieldCheck, tone: 'accent' },
  PLATFORM_ADMIN_PASSWORD_SET: { icon: KeyRound, tone: 'neutral' },
  VISITOR_CREATED: { icon: Contact, tone: 'info' },
  VISITOR_UPDATED: { icon: Contact, tone: 'info' },
  VISIT_CREATED: { icon: CalendarPlus, tone: 'info' },
  VISIT_UPDATED: { icon: CalendarClock, tone: 'info' },
  VISIT_RESCHEDULED: { icon: CalendarClock, tone: 'info' },
  VISIT_TIME_SHIFTED: { icon: CalendarClock, tone: 'neutral' },
  VISIT_CANCELLED: { icon: CalendarX, tone: 'neutral' },
  VISIT_MARKED_NO_SHOW: { icon: UserRoundX, tone: 'warning' },
  VISIT_CHECKED_IN: { icon: DoorOpen, tone: 'success' },
  WALK_IN_CREATED: { icon: UserPlus, tone: 'success' },
  VISIT_CHECKED_OUT: { icon: LogOut, tone: 'neutral', mirror: true },
  STALE_VISITS_CHECKED_OUT: { icon: LogOut, tone: 'neutral', mirror: true },
  PASS_ISSUED: { icon: QrCode, tone: 'neutral' },
  // Phase 15: visitor tracking.
  TRACKING_ENROLLMENT_REQUESTED: { icon: Route, tone: 'info' },
  TRACKING_ASSOCIATION_ACTIVATED: { icon: Route, tone: 'info' },
  TRACKING_ASSOCIATION_ENDED: { icon: Route, tone: 'neutral' },
  TRACKING_ASSOCIATION_REVOKED: { icon: Route, tone: 'neutral' },
  JOURNEY_VIEWED: { icon: Route, tone: 'neutral' },
  JOURNEY_LIST_VIEWED: { icon: Route, tone: 'neutral' },
  TRACKING_ENABLED: { icon: Radar, tone: 'accent' },
  TRACKING_DISABLED: { icon: Radar, tone: 'neutral' },
  TRACKING_ALLOWED: { icon: Radar, tone: 'accent' },
  TRACKING_DISALLOWED: { icon: Radar, tone: 'neutral' },
  TRACKING_SETTINGS_UPDATED: { icon: Settings, tone: 'accent' },
  TRACKING_KEY_CREATED: { icon: KeyRound, tone: 'accent' },
  TRACKING_KEY_REVOKED: { icon: KeyRound, tone: 'neutral' },
  TRACKING_CAMERA_CREATED: { icon: Cctv, tone: 'accent' },
  TRACKING_CAMERA_UPDATED: { icon: Cctv, tone: 'accent' },
  LOCATION_CREATED: { icon: MapPinned, tone: 'accent' },
  LOCATION_UPDATED: { icon: MapPinned, tone: 'accent' },
  PASS_REVOKED: { icon: QrCode, tone: 'neutral' },
  PASS_SCANNED: { icon: ScanLine, tone: 'success' },
  INVITATION_QUEUED: { icon: Mail, tone: 'info' },
  INVITATION_SENT: { icon: Mail, tone: 'info' },
}

const OTHER: AuditEventVisual = { icon: ScrollText, tone: 'neutral' }

/**
 * The icon and tone of an event's tile: failures and denials stand out (a red shield for security
 * events, an amber warning for the rest), routine events take their kind's icon. An action this
 * table does not know (a newer server) gets the audit log's own icon.
 */
export function auditEventVisual(log: Pick<AuditLog, 'action' | 'metadata'>): AuditEventVisual {
  if (isFailureEvent(log)) return SECURITY_ACTIONS.has(log.action) ? { icon: ShieldAlert, tone: 'danger' } : { icon: TriangleAlert, tone: 'warning' }
  return ACTION_VISUALS[log.action] ?? OTHER
}

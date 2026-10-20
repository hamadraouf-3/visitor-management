/**
 * TypeScript mirror of the API contract (docs/initial-assessment.md §8, §8.1, §8.2).
 *
 * Section 1 mirrors §8.1 exactly (field names, optionality and nullability); the backend
 * Pydantic schemas mirror the same section. Section 2 types the envelopes from §8.
 * Section 3 types request bodies and query parameters listed in the §8 endpoint table.
 *
 * Conventions: `?` = optional in requests; `| null` = nullable in responses. IDs are UUID
 * strings; datetimes are ISO-8601 strings (UTC `…Z` in responses, timezone-aware in requests);
 * date-only values are company-local `YYYY-MM-DD`.
 */

/* ------------------------------------------------------------------------------------------ */
/* 1. §8.1 schemas                                                                             */
/* ------------------------------------------------------------------------------------------ */

export type Role = 'SYSTEM_ADMIN' | 'EMPLOYEE' | 'RECEPTIONIST' | 'MANAGEMENT'
export type VisitStatus = 'SCHEDULED' | 'CHECKED_IN' | 'CHECKED_OUT' | 'CANCELLED' | 'NO_SHOW'
export type CheckInMethod = 'QR' | 'MANUAL' | 'OVERRIDE' | 'WALK_IN'
export type CheckOutMethod = 'QR' | 'MANUAL' | 'CORRECTED' | 'BULK'
export type InvitationStatus = 'NOT_SENT' | 'PENDING' | 'SENT' | 'FAILED'
export type PassStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED' | 'NONE'
export type PassRevokeReason = 'ROTATED' | 'VISIT_CANCELLED' | 'VISIT_COMPLETED' | 'VISITOR_EMAIL_CHANGED'
/**
 * Interface and e-mail language (Phase 10, docs/decisions/phase-10-backend.md B10-1). Not exported: every
 * exported name must match a backend model (api.contract.test.ts); use `PreferencesUpdate['language']`.
 */
type Language = 'ar' | 'en'

export interface UserRef {
  id: string
  full_name: string
}

/**
 * A department as other resources embed it (phase 10 shared contract). The UI shows
 * `name_ar` when it is Arabic and `name_ar` is set, else `name`: through `useDepartmentName`
 * (src/i18n/departmentName.ts), never `name` directly.
 */
export interface DepartmentRef {
  id: string
  /** The default (English) name. */
  name: string
  /** The Arabic name; null when unset. */
  name_ar: string | null
}

export interface Me {
  user: {
    id: string
    full_name: string
    email: string
    phone: string | null
    roles: Role[]
    department: DepartmentRef | null
    must_change_password: boolean
    /** The user's own language; null follows `company.default_language`. */
    preferred_language: Language | null
  }
  company: {
    id: string
    /** The English (or only) name. */
    name: string
    /** Shown instead of `name` when the interface is Arabic; null when unset. */
    name_ar: string | null
    /** The company's name in links: its sign-in page is `/c/{slug}` (Phase 12). */
    slug: string
    timezone: string
    default_language: Language
    /** The company's identity: its logos and colour (Phase 12). */
    brand: CompanyBrand
    /**
     * The company's address (Phase 14: a calendar event's location); null when unset. The Arabic UI uses
     * `address_ar`, else `address`; the English UI `address`, else `address_ar`.
     */
    address: string | null
    address_ar: string | null
  }
}

/* Phase 12: a company's identity (docs/decisions/phase-12-frontend.md) ------------------------- */

/**
 * The palette the backend derives from a company's colour: the only colours the SPA and the e-mails
 * pair as text and background. Each is `#rrggbb`, lower case. Guaranteed: white on `strong` and on
 * `strong_hover` at least 4.5:1, white on `deep` at least 10:1, `on_bright` on `bright` and `bright`
 * on `deep` at least 4.5:1, `strong` on `tint` at least 4.5:1, `on_surface` on `surface` and on
 * `surface_hover` at least 4.5:1.
 */
export interface BrandPalette {
  /**
   * What brand surfaces are painted with (the app shell, primary buttons): the chosen colour itself
   * wherever white or the dark ink reads on it, so a yellow company is yellow; `strong` for a
   * mid-tone on which neither does.
   */
  surface: string
  /** The ink on `surface`: white, or the dark ink (`on_bright`). */
  on_surface: string
  /** The hover and pressed step of `surface`. */
  surface_hover: string
  /** Text, links and icons on white, and surfaces under white text. */
  strong: string
  /** Darker than `strong`: hover and pressed. */
  strong_hover: string
  /** A very dark step of the hue, for dark surfaces. */
  deep: string
  /** A light vivid step: accents on dark surfaces, fills under dark text. */
  bright: string
  /** A near-white tint for chips and selected rows. */
  tint: string
  /** The border of tinted elements (decorative). */
  tint_border: string
  on_strong: string
  /** Dark ink. */
  on_bright: string
}

/** A company's identity as every payload carries it. */
export interface CompanyBrand {
  /** Same-origin path of the logo for light surfaces, cache-busted; null: the company has none. */
  logo_url: string | null
  /** The optional logo for the coloured shell and dark surfaces. */
  logo_dark_url: string | null
  /** The square app icon. */
  icon_url: string | null
  /** The chosen colour (`#rrggbb`), or null: the default palette. */
  color: string | null
  /** Null exactly when `color` is null. */
  palette: BrandPalette | null
  /** Changes whenever an asset or the colour changes. */
  version: string
}

/** GET /public/companies/{slug}/brand: what a company's sign-in and pass pages show (no session). */
export interface PublicCompanyBrand {
  slug: string
  name: string
  name_ar: string | null
  default_language: Language
  brand: CompanyBrand
}

export interface User {
  id: string
  full_name: string
  email: string
  phone: string | null
  roles: Role[]
  department: DepartmentRef | null
  is_active: boolean
  must_change_password: boolean
  last_login_at: string | null
  created_at: string
  updated_at: string
  /** Present on PATCH /users/{id} when hosted SCHEDULED visits were cancelled (D-18). */
  cancelled_visits?: number
}

export interface Host {
  id: string
  full_name: string
  phone: string | null
  department: DepartmentRef | null
}

export interface Department {
  id: string
  /** The default (English) name; unique per company, ignoring case. */
  name: string
  /** The Arabic name (the rules of `name`, unique per company when set); null when unset. */
  name_ar: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface CompanySettings {
  id: string
  name: string
  /** The Arabic name (same rules as `name`); null when unset. */
  name_ar: string | null
  /** Users without a preference see this language; visitor e-mails lead with it. */
  default_language: Language
  timezone: string
  address: string | null
  /** The Arabic address (the rules of `address`); the Arabic UI and e-mail sections use it when set. */
  address_ar: string | null
  email_domain: string | null
  pass_grace_before_minutes: number
  pass_grace_after_minutes: number
  notify_host_on_check_in: boolean
  allow_walk_ins: boolean
}

export interface Visitor {
  id: string
  full_name: string
  email: string | null
  phone: string | null
  company_name: string | null
  created_at: string
  updated_at: string
  /** Within the caller's scope. */
  stats: { total_visits: number; last_visit_at: string | null }
  permissions: { can_edit: boolean }
}

/** `today_visits`: SCHEDULED/CHECKED_IN visits today, in scope. */
export interface VisitorSearchItem extends Visitor {
  today_visits: Visit[]
}

export interface Visit {
  id: string
  status: VisitStatus
  /** Snapshot. */
  visitor: { id: string; full_name: string; company_name: string | null }
  /** Name = snapshot, phone = current. */
  host: { id: string; full_name: string; phone: string | null }
  /** Name = snapshot. */
  department: DepartmentRef | null
  purpose: string
  scheduled_start: string
  scheduled_end: string
  window_start: string
  window_end: string
  is_walk_in: boolean
  walk_in_reason: string | null
  check_in_at: string | null
  check_in_method: CheckInMethod | null
  check_in_note: string | null
  checked_in_by: UserRef | null
  check_out_at: string | null
  check_out_method: CheckOutMethod | null
  check_out_note: string | null
  checked_out_by: UserRef | null
  cancelled_at: string | null
  cancellation_reason: string | null
  cancelled_by: UserRef | null
  no_show_at: string | null
  duration_seconds: number | null
  /** CHECKED_IN and now > scheduled_end. */
  is_overdue: boolean
  /** CHECKED_IN and check-in before company-local today. */
  is_stale: boolean
  created_by: UserRef
  created_at: string
  updated_at: string
  /** Latest VISITOR_INVITATION email, or the failure of the calendar invitation that followed it. */
  invitation: {
    status: InvitationStatus
    to_email: string | null
    attempts: number
    last_attempt_at: string | null
    sent_at: string | null
    error: string | null
    /**
     * FAILED because the calendar invitation that followed the latest invitation failed, while the
     * invitation itself went out or is still being sent (Phase 14, B14-18): `to_email`, `attempts`,
     * `last_attempt_at` and `error` are then the calendar invitation's. False for any other state; a
     * resend clears it.
     */
    calendar_failed: boolean
  }
  /**
   * Latest VISIT_CANCELLED / VISIT_RESCHEDULED email to the visitor, or null when none was
   * queued (contract addition B57-03). `error` is set while it is not SENT.
   */
  last_notice: {
    kind: 'VISIT_CANCELLED' | 'VISIT_RESCHEDULED'
    status: 'PENDING' | 'SENT' | 'FAILED'
    to_email: string
    sent_at: string | null
    error: string | null
  } | null
  pass: { status: PassStatus; issued_at: string | null; revoke_reason: PassRevokeReason | null }
  /**
   * The SEQUENCE of the visit's calendar events (Phase 14): 0 when created, one more at each reschedule
   * and at the cancellation.
   */
  calendar_sequence: number
  /**
   * Whether the visitor was sent the visit's calendar invitation (Phase 14, `VISITOR_CALENDAR`). Then a
   * cancellation always e-mails them, and so removes the visit from their calendar, whatever
   * `notify_visitor` says (the owner's decision).
   */
  visitor_calendar_sent: boolean
  permissions: {
    can_edit: boolean
    can_cancel: boolean
    can_resend: boolean
    can_check_in: boolean
    can_check_out: boolean
  }
}

export interface VisitCreate {
  visitor_id?: string
  /** Exactly one of `visitor_id` / `visitor`. */
  visitor?: { full_name: string; email?: string; phone?: string; company_name?: string }
  /**
   * Any active host for a SYSTEM_ADMIN caller; any other caller's own id (else 422 on `host_id`,
   * code `host_must_be_self`; §7.5).
   */
  host_id: string
  department_id?: string
  purpose: string
  /** Timezone-aware ISO. */
  scheduled_start: string
  /** Timezone-aware ISO. */
  scheduled_end: string
  /** `true` requires a visitor email. */
  send_invitation: boolean
}

export interface VisitCreateResult {
  visit: Visit
  /** One-time pass link (`{QR_BASE_URL}/pass#<token>`); never retrievable again. */
  pass_url: string
  visitor_match: { reused: boolean }
}

/**
 * POST /visits/{id}/invitation: the visit, and the new pass's one-time link; null when only the calendar
 * invitation was sent again (it alone had failed, `invitation.calendar_failed`, B14-31): the pass the
 * visitor has stays valid.
 */
export interface VisitResendResult {
  visit: Visit
  pass_url: string | null
  visitor_match: { reused: boolean }
}

/** POST /visits/{id}/pass (contract addition B57-04): a new pass for the host to share; the previous one stops working. */
export interface VisitPassResult {
  visit: Visit
  /** One-time pass link; never retrievable again. */
  pass_url: string
}

export type WalkInReason = 'NO_INVITATION' | 'EARLY_ARRIVAL' | 'LATE_ARRIVAL' | 'LOST_PASS' | 'DELIVERY' | 'OTHER'

export interface WalkInCreate {
  visitor_id?: string
  visitor?: { full_name: string; email?: string; phone?: string; company_name?: string }
  host_id: string
  department_id?: string
  purpose: string
  /** Default now + 1h in the UI. */
  expected_end: string
  reason: WalkInReason
  /** Required when reason = OTHER. */
  reason_note?: string
}

export interface ScanWarning {
  code: 'OUTSIDE_SCHEDULED_TIME' | 'OVERSTAYED'
  message: string
}

export interface ScanResult {
  result: 'READY' | 'ALREADY_CHECKED_IN'
  visit: Visit
  warnings: ScanWarning[]
  actions: { check_in: boolean; check_out: boolean }
}

export interface ScanErrorDetails {
  visit?: Visit
  check_in_options?: ('MANUAL' | 'OVERRIDE')[]
}

export interface ReceptionToday {
  /** Company-local YYYY-MM-DD. */
  date: string
  counts: {
    expected: number
    inside: number
    checked_out: number
    no_show: number
    cancelled: number
    walk_ins: number
  }
  /** Each list capped at 200 (counts exact). */
  expected: Visit[]
  inside: Visit[]
  checked_out: Visit[]
  no_show: Visit[]
}

export interface EmployeeDashboard {
  counts: {
    today: number
    upcoming: number
    inside: number
    completed_30d: number
    cancelled_30d: number
    needs_attention: number
  }
  today: Visit[]
}

export interface AuditLog {
  id: string
  seq: number
  created_at: string
  action: string
  actor: UserRef | null
  entity_type: string | null
  entity_id: string | null
  metadata: Record<string, unknown>
  ip_address: string | null
  user_agent: string | null
  request_id: string | null
}

export interface AdminDashboard {
  counts: {
    visitors_total: number
    visits_total: number
    inside_now: number
    visits_today: number
    employees: number
    receptionists: number
    management: number
    admins: number
  }
  /** Latest 10. */
  recent_audit: AuditLog[]
}

/* Phase 11: the platform owner (docs/decisions/phase-11-backend.md B11-1 … B11-13) -------------- */

/** GET /platform/auth/me (401 when no platform session): the platform owner, not a user of any company. */
export interface PlatformMe {
  admin: {
    id: string
    full_name: string
    email: string
    must_change_password: boolean
    /** The platform pages' language; null follows the device. */
    preferred_language: Language | null
  }
}

/** A company as the platform owner sees it: its identity, its state and two aggregates (B11-2). */
export interface PlatformCompany {
  id: string
  name: string
  name_ar: string | null
  /** 1–80 lowercase letters, digits and inner hyphens; never changes. */
  slug: string
  timezone: string
  default_language: Language
  is_active: boolean
  deactivated_at: string | null
  created_at: string
  updated_at: string
  counts: {
    active_users: number
    /** Visits scheduled to start in the 30 days up to now, any status. */
    visits_last_30_days: number
  }
  /** The company's identity (Phase 12): lists show its logo. */
  brand: CompanyBrand
}

/** One of a company's administrators (SYSTEM_ADMIN): the only users the platform owner sees. */
export interface PlatformCompanyAdmin {
  id: string
  full_name: string
  email: string
  is_active: boolean
  must_change_password: boolean
  last_login_at: string | null
  created_at: string
}

/** POST /platform/companies: the company and its first administrator. */
export interface PlatformCompanyCreated {
  company: PlatformCompany
  admin: PlatformCompanyAdmin
}

/** POST /platform/companies/{id}/admins/{user_id}/password-reset (202). */
export interface AdminPasswordResetSent {
  sent_to: string
}

/** A row of the platform's own audit trail (B11-4). */
export interface PlatformAuditLog {
  id: string
  seq: number
  created_at: string
  action: string
  /** Null for the CLI and unattributed events. */
  actor: { id: string; full_name: string } | null
  /** The company the action was about; null for actions about no company. */
  company: { id: string; name: string; name_ar: string | null } | null
  entity_type: string | null
  entity_id: string | null
  metadata: Record<string, unknown>
  ip_address: string | null
  user_agent: string | null
  request_id: string | null
}

/* Phase 11: a company's e-mail texts (B11-20 … B11-31) ---------------------------------------- */

/**
 * The e-mails whose texts a company may change; the security e-mails may not (B11-21). The `HOST_VISIT_*`
 * kinds (Phase 14) tell the host of a scheduled visit, created, moved or cancelled, and carry the host's
 * calendar event.
 */
export type EmailTemplateKind =
  | 'VISITOR_INVITATION'
  | 'VISIT_RESCHEDULED'
  | 'VISIT_CANCELLED'
  | 'HOST_ARRIVAL'
  | 'HOST_VISIT_SCHEDULED'
  | 'HOST_VISIT_RESCHEDULED'
  | 'HOST_VISIT_CANCELLED'

/** An editable text of an e-mail; which kind has which is the template's `fields`. */
export type EmailTemplateFieldName = 'subject' | 'heading' | 'greeting' | 'intro' | 'button' | 'closing' | 'footer_note'

/** One editable text: its limits, the product's text and the company's (null: the product's). */
interface EmailTemplateTextField {
  name: EmailTemplateFieldName
  multiline: boolean
  max_length: number
  required_variables: string[]
  /** Variables of the kind that this text may not hold (B11-40: `purpose` in a subject); empty for most. */
  forbidden_variables: string[]
  default: { ar: string; en: string }
  override: { ar: string | null; en: string | null }
}

export interface EmailTemplate {
  kind: EmailTemplateKind
  /** The kind's allow-list of `{variable}` names, in the order the API lists them. */
  variables: string[]
  /** How often one variable may appear in one text (B11-40). */
  max_variable_uses: number
  /** The last change or reset of a text of the kind; null: never edited. */
  updated_at: string | null
  fields: EmailTemplateTextField[]
}

/**
 * Texts of one language. A field left out is unchanged; null or blank returns it to the product's
 * text. Plain text: `{variable}` placeholders, and line breaks in multi-line fields.
 */
interface EmailTemplateTexts {
  subject?: string | null
  heading?: string | null
  greeting?: string | null
  intro?: string | null
  button?: string | null
  closing?: string | null
  footer_note?: string | null
}

/** PATCH /email-templates/{kind}: field errors at `ar.<field>` / `en.<field>`; all or nothing. */
export interface EmailTemplateUpdate {
  ar?: EmailTemplateTexts | null
  en?: EmailTemplateTexts | null
}

/** POST /email-templates/{kind}/reset: one language, or both when omitted or null. */
export interface EmailTemplateReset {
  language?: Language | null
}

/**
 * The colour scheme an e-mail is previewed in (Phase 13): `light` is the e-mail as sent, `dark` the same
 * e-mail with its dark design applied, as a mail client in its dark mode shows it.
 */
export type EmailScheme = 'light' | 'dark'

/**
 * POST /email-templates/{kind}/preview and /test: `language` leads; `ar` / `en` are an unsaved draft over
 * the saved texts. `scheme` (preview only; light when omitted): the test e-mail is the real one, with both
 * schemes inside, and is never sent with it.
 */
export interface EmailTemplatePreviewRequest {
  language: Language
  ar?: EmailTemplateTexts | null
  en?: EmailTemplateTexts | null
  scheme?: EmailScheme
}

/** The e-mail rendered with sample data; nothing is sent or saved. */
export interface EmailPreview {
  kind: EmailTemplateKind
  language: Language
  subject: string
  /** A full document relying on inline styles: show the saved texts with the GET preview document instead. */
  html: string
  text: string
}

/** POST /email-templates/{kind}/test (202): sent to the caller's own address. */
export interface EmailTestSent {
  sent_to: string
}

export interface ReportSummary {
  date_from: string
  date_to: string
  timezone: string
  totals: {
    visits: number
    unique_visitors: number
    checked_in: number
    checked_out: number
    no_show: number
    cancelled: number
    walk_ins: number
  }
  /** no_show / (visits that reached a final or checked-in state). */
  no_show_rate: number | null
  /** Excludes CORRECTED and BULK check-outs. */
  avg_duration_seconds: number | null
  visits_per_day: { date: string; count: number }[]
  /** `name`/`name_ar` as on `DepartmentRef` ("No department" for the visits without one). */
  by_department: { department_id: string | null; name: string; name_ar: string | null; count: number }[]
  /** Top 10. */
  top_hosts: { host_id: string; full_name: string; count: number }[]
  /** 0..23, company timezone. */
  check_ins_by_hour: { hour: number; count: number }[]
}

/* ------------------------------------------------------------------------------------------ */
/* 2. Envelopes (§8, §8.2)                                                                     */
/* ------------------------------------------------------------------------------------------ */

/**
 * Error codes from §8.2, plus the framework-level codes the backend uses for HTTP errors
 * outside §8.2 (B1-08): 405 → METHOD_NOT_ALLOWED, any other framework 4xx → BAD_REQUEST, and
 * 413 → PAYLOAD_TOO_LARGE for a request body above the server's size limit.
 */
export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'METHOD_NOT_ALLOWED'
  | 'PAYLOAD_TOO_LARGE'
  /** Phase 12: a body that is not of the one type the endpoint takes (415): a brand image is `image/png` (B12-6). */
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'NOT_AUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'CSRF_FAILED'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'INVALID_RESET_TOKEN'
  | 'INVALID_CURRENT_PASSWORD'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'USER_EMAIL_UNAVAILABLE'
  | 'LAST_ADMIN'
  | 'SELF_MODIFICATION'
  | 'VISITOR_EXISTS'
  | 'INVALID_STATE_TRANSITION'
  | 'VISIT_NOT_EDITABLE'
  | 'VISIT_ALREADY_CHECKED_IN'
  | 'VISIT_NOT_CHECKED_IN'
  | 'VISITOR_ALREADY_INSIDE'
  | 'VISIT_CANCELLED'
  | 'VISIT_COMPLETED'
  | 'HOST_INACTIVE'
  | 'PASS_NOT_YET_VALID'
  | 'PASS_EXPIRED'
  | 'PASS_REVOKED'
  | 'PASS_INVALID'
  | 'VISITOR_EMAIL_REQUIRED'
  | 'WALK_INS_DISABLED'
  | 'OVERRIDE_NOT_ALLOWED'
  | 'VALIDATION_ERROR'
  | 'RATE_LIMITED'
  | 'INVITATION_LIMIT'
  | 'SERVICE_BUSY'
  | 'INTERNAL_ERROR'
  /** Phase 11: the platform owner acted on a deactivated company where that means nothing (409). */
  | 'COMPANY_INACTIVE'
  /** Phase 11: the platform owner asked for a reset link of a deactivated administrator (409). */
  | 'ACCOUNT_INACTIVE'

/**
 * The machine code of one field error of a 422 VALIDATION_ERROR (backend B10-18): one per kind of
 * problem, the vocabulary of the snapshot's `field_error_codes`. Codes with parameters:
 * `invalid_choice` {choices}, `too_short` / `too_few_items` / `too_small` {min}, `too_long` /
 * `too_many_items` / `too_large` {max}, `date_out_of_range` / `datetime_out_of_range` {min, max},
 * `visit_too_long` {max_hours}, `too_far_ahead` / `range_too_long` {max_days},
 * `walk_in_before_window` {time}, `too_many_reinvitations` {count, limit},
 * `image_too_small` {min_width, min_height}, `image_too_large` {max_width, max_height}.
 * `host_must_be_self` (phase 10): a caller without SYSTEM_ADMIN invited for another host.
 */
export type FieldErrorCode =
  | 'required'
  | 'not_allowed'
  | 'invalid_json'
  | 'invalid'
  | 'invalid_text'
  | 'invalid_format'
  | 'invalid_choice'
  | 'invalid_id'
  | 'invalid_integer'
  | 'invalid_number'
  | 'invalid_boolean'
  | 'invalid_list'
  | 'invalid_object'
  | 'invalid_date'
  | 'invalid_datetime'
  | 'offset_required'
  | 'offset_not_allowed'
  | 'too_short'
  | 'too_long'
  | 'too_few_items'
  | 'too_many_items'
  | 'too_small'
  | 'too_large'
  | 'date_out_of_range'
  | 'datetime_out_of_range'
  | 'out_of_range'
  | 'unstorable_value'
  | 'control_characters'
  | 'bidi_controls'
  | 'line_breaks'
  | 'invalid_email'
  | 'invalid_domain'
  | 'invalid_phone'
  | 'invalid_timezone'
  | 'duplicates'
  | 'end_before_start'
  | 'not_found'
  | 'host_unavailable'
  | 'host_must_be_self'
  | 'department_inactive'
  | 'visitor_required'
  | 'visitor_both'
  | 'end_not_after_start'
  | 'visit_too_long'
  | 'end_in_past'
  | 'start_in_past'
  | 'too_far_ahead'
  | 'range_too_long'
  | 'expected_end_in_past'
  | 'check_out_before_check_in'
  | 'check_out_in_future'
  | 'walk_in_expected_visit'
  | 'walk_in_during_window'
  | 'walk_in_before_window'
  | 'walk_in_needs_record'
  | 'too_many_reinvitations'
  | 'password_is_email'
  | 'password_common'
  | 'password_guessable'
  | 'password_personal'
  | 'password_unchanged'
  /** Phase 11, e-mail texts: `{name}` is not one of the e-mail's variables `allowed`. */
  | 'unknown_placeholder'
  /** Phase 11, e-mail texts: the text must contain the variable `{name}`. */
  | 'placeholder_required'
  /** Phase 11, e-mail texts: a brace that is not part of a `{variable}`. */
  | 'invalid_placeholder'
  /** Phase 11, e-mail texts: an HTML tag or character reference in plain text. */
  | 'markup_not_allowed'
  /** Phase 11, e-mail texts: `{name}` is a variable of the e-mail, but not of this text (B11-40). */
  | 'placeholder_not_allowed'
  /** Phase 11, e-mail texts: `{name}` appears more than `max` times in the text (B11-40). */
  | 'placeholder_repeated'
  /** Phase 12, a company's brand: not a colour written `#rrggbb` in lower case (B12-4). */
  | 'invalid_color'
  /** Phase 12, a company's brand: not a PNG image the product stores (B12-6); on the field `file`, as the next three. */
  | 'invalid_image'
  /** Phase 12: fewer than `min_width` × `min_height` pixels. */
  | 'image_too_small'
  /** Phase 12: more than `max_width` × `max_height` pixels. */
  | 'image_too_large'
  /** Phase 12: an icon whose width is not its height. */
  | 'image_not_square'

/** `details.field_codes[path]`: the code and exactly the parameters it declares (`{}` for most). */
export interface FieldErrorCodeEntry {
  code: FieldErrorCode
  params: Record<string, number | string | string[]>
}

/**
 * `details` of a 422 VALIDATION_ERROR: field path → message written in English for people, and
 * (B10-18) the same paths → their code, for showing the problem in the UI language.
 */
export interface ValidationErrorDetails {
  fields?: Record<string, string>
  field_codes?: Record<string, FieldErrorCodeEntry>
}

/**
 * Every non-2xx response body, as it arrives on the wire: `code` is any string here (the
 * backend's `ErrorBody.code`); `ApiError['code']` in the API client narrows it for callers.
 */
export interface ApiErrorEnvelope {
  error: {
    code: string
    message: string
    details: Record<string, unknown>
  }
  request_id: string | null
}

export interface Paginated<T> {
  items: T[]
  page: number
  page_size: number
  total: number
}

/* Each paginated endpoint's response by name, so the contract test compares every instantiation. */

/** GET /users */
export type UserPage = Paginated<User>
/** GET /visitors */
export type VisitorSearchPage = Paginated<VisitorSearchItem>
/** GET /visits and GET /visitors/{id}/visits */
export type VisitPage = Paginated<Visit>
/** GET /audit-logs */
export type AuditLogPage = Paginated<AuditLog>
/** GET /platform/companies */
export type PlatformCompanyPage = Paginated<PlatformCompany>
/** GET /platform/audit-logs */
export type PlatformAuditLogPage = Paginated<PlatformAuditLog>

/* ------------------------------------------------------------------------------------------ */
/* 3. Request bodies, query parameters and small responses from the §8 endpoint table          */
/* ------------------------------------------------------------------------------------------ */

export interface PageParams {
  page?: number
  /** Max 100. */
  page_size?: number
}

export interface HealthResponse {
  status: 'ok'
  database: 'ok'
}

export interface LoginRequest {
  email: string
  password: string
}

/** PATCH /auth/preferences → `Me`. Allowed while a password change is required. */
export interface PreferencesUpdate {
  language: Language
}

export interface ChangePasswordRequest {
  current_password: string
  new_password: string
}

export interface ForgotPasswordRequest {
  email: string
}

export interface ForgotPasswordResponse {
  message: string
}

export interface ResetPasswordRequest {
  token: string
  new_password: string
}

export interface HostSearchParams {
  q?: string
}

export interface UserListParams extends PageParams {
  q?: string
  /** Users holding any of these roles; sent comma-separated (§8, B1-20). */
  role?: Role[]
  is_active?: boolean
}

export interface UserCreate {
  full_name: string
  email: string
  phone?: string
  roles: Role[]
  department_id?: string
  temporary_password: string
}

export interface UserUpdate {
  full_name?: string
  phone?: string | null
  department_id?: string | null
  roles?: Role[]
  is_active?: boolean
}

export interface DepartmentListParams {
  /** Admin only. */
  include_inactive?: boolean
}

export interface DepartmentCreate {
  name: string
  /** Omitted: no Arabic name. */
  name_ar?: string
}

export interface DepartmentUpdate {
  name?: string
  /** null clears it. */
  name_ar?: string | null
  is_active?: boolean
}

export type CompanySettingsUpdate = Partial<Omit<CompanySettings, 'id'>>

export interface VisitorSearchParams extends PageParams {
  q?: string
}

export interface VisitorCreate {
  full_name: string
  email?: string
  phone?: string
  company_name?: string
}

export interface VisitorUpdate {
  full_name?: string
  email?: string | null
  phone?: string | null
  company_name?: string | null
}

export interface VisitListParams extends PageParams {
  scope?: 'mine' | 'all'
  /** Sent comma-separated. */
  status?: VisitStatus[]
  /** Company-local YYYY-MM-DD. */
  date_from?: string
  /** Company-local YYYY-MM-DD. */
  date_to?: string
  host_id?: string
  visitor_id?: string
  department_id?: string
  needs_attention?: boolean
  q?: string
  order?: 'asc' | 'desc'
}

export interface VisitUpdate {
  purpose?: string
  department_id?: string | null
  scheduled_start?: string
  scheduled_end?: string
}

export interface VisitCancelRequest {
  reason?: string
  /** Defaults to true on the server. */
  notify_visitor?: boolean
}

export type CheckInRequest =
  | { method: 'QR'; pass_token: string }
  | { method: 'MANUAL' }
  | { method: 'OVERRIDE'; reason: string }

export type CheckOutRequest =
  | { method: 'QR'; pass_token: string }
  | { method: 'MANUAL' }
  | { method: 'CORRECTED'; check_out_at: string; note: string }

export interface ScanRequest {
  token: string
}

/**
 * An entry of the evacuation list (B57-72): a visit whose visitor also carries the visitor
 * record's current phone, so staff at the assembly point can call a missing visitor. Only
 * `GET /reception/inside` carries it; `Visit` itself is unchanged.
 */
export interface InsideVisit extends Omit<Visit, 'visitor'> {
  /** Snapshot, plus the visitor record's current phone. */
  visitor: { id: string; full_name: string; company_name: string | null; phone: string | null }
}

export interface InsideList {
  count: number
  items: InsideVisit[]
}

export interface CheckOutStaleRequest {
  reason: string
}

export interface CheckOutStaleResult {
  checked_out: number
}

export interface ReportSummaryParams {
  /** Company-local YYYY-MM-DD; default last 30 days, max 366. */
  date_from?: string
  date_to?: string
}

export interface AuditLogListParams extends PageParams {
  action?: string
  actor_user_id?: string
  entity_type?: string
  entity_id?: string
  date_from?: string
  date_to?: string
}

/* Phase 11: the platform owner ----------------------------------------------------------------- */

/** GET /platform/companies: `q` matches the name, the Arabic name or the slug. */
export interface PlatformCompanyListParams extends PageParams {
  q?: string | null
  is_active?: boolean | null
}

/** A company administrator created by the platform owner: a SYSTEM_ADMIN with a forced password change. */
export interface CompanyAdminCreate {
  full_name: string
  email: string
  temporary_password: string
}

/** POST /platform/companies: the company and its first administrator. */
export interface PlatformCompanyCreate {
  name: string
  /** Omitted or null: no Arabic name. */
  name_ar?: string | null
  slug: string
  timezone: string
  default_language: Language
  admin: CompanyAdminCreate
}

/** PATCH /platform/companies/{id}: omitted fields are unchanged; `name_ar` null clears it. The slug never changes. */
export interface PlatformCompanyUpdate {
  name?: string | null
  name_ar?: string | null
  timezone?: string | null
  default_language?: Language | null
}

/** GET /platform/audit-logs: newest first; `company_id` keeps the rows about that company. */
export interface PlatformAuditLogListParams extends PageParams {
  company_id?: string | null
  action?: string | null
}

/** GET /email-templates/{kind}/preview: the language that leads the previewed e-mail, and its colour scheme (light when omitted). */
export interface EmailPreviewDocumentParams {
  language: Language
  scheme?: EmailScheme
}

/**
 * GET /public/companies/{slug}/brand/{kind}.png: `v` is the image's version, as the addresses of a
 * `CompanyBrand` carry it. It selects nothing (the image is always the current one): it only decides
 * how long the answer may be kept. The app never builds this query: it uses the addresses as they come.
 */
export interface BrandImageParams {
  v?: string | null
}

/** PATCH /platform/companies/{id}/brand: the company's colour (`#rrggbb`), or null for the default palette. */
export interface CompanyBrandUpdate {
  color: string | null
}

/** POST /platform/brand/palette: the palette a colour would give; nothing is saved. */
export interface BrandPaletteRequest {
  color: string
}

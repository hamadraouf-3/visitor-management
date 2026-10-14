import { getErrorMessage, isApiError } from '../../api/client'
import { catalogText } from '../../i18n/catalogText'
import { currentLanguage, i18n } from '../../i18n'
import type { ScanErrorDetails, ScanResult, ScanWarning, Visit, WalkInReason } from '../../types/api'
import { formatTimeOnDay, formatTimeRange, momentOnDay } from '../../utils/datetime'
import { formatAgo, formatIn, secondsBetween } from '../../utils/duration'

const t = i18n.getFixedT(null, 'reception')

/** A check-in the server offers for a refused pass (`details.check_in_options`, §6). */
export type CheckInOption = NonNullable<ScanErrorDetails['check_in_options']>[number]

/** §6 rows 2–3 and 5–8: refusals that carry `details.visit` and `details.check_in_options`. */
export const SCAN_REFUSAL_CODES = [
  'VISIT_CANCELLED',
  'VISIT_COMPLETED',
  'HOST_INACTIVE',
  'PASS_REVOKED',
  'PASS_EXPIRED',
  'PASS_NOT_YET_VALID',
] as const
export type ScanRefusalCode = (typeof SCAN_REFUSAL_CODES)[number]

/** What a scan found, in the terms the result panel shows. */
export type ScanOutcome =
  /** Row 9: inside the pass window; check-in is the primary action. */
  | { kind: 'ready'; visit: Visit; warnings: ScanWarning[]; canCheckIn: boolean }
  /** Row 4: the visitor is inside; check-out is offered. */
  | { kind: 'inside'; visit: Visit; warnings: ScanWarning[]; canCheckOut: boolean }
  /** Rows 2–3, 5–8: the pass cannot be used as it is; `options` are the check-ins still possible. */
  | { kind: 'refused'; code: ScanRefusalCode; message: string; visit: Visit | null; options: CheckInOption[] }
  /** Row 1: not a pass of this company (or not a pass at all). */
  | { kind: 'invalid'; message: string }
  /** No verdict: network failure, rate limit, server error, missing permission. */
  | { kind: 'failed'; error: unknown }

export function outcomeFromScanResult(result: ScanResult): Extract<ScanOutcome, { kind: 'ready' | 'inside' }> {
  if (result.result === 'READY') {
    return { kind: 'ready', visit: result.visit, warnings: result.warnings, canCheckIn: result.actions.check_in }
  }
  return { kind: 'inside', visit: result.visit, warnings: result.warnings, canCheckOut: result.actions.check_out }
}

function isRefusalCode(code: string): code is ScanRefusalCode {
  return (SCAN_REFUSAL_CODES as readonly string[]).includes(code)
}

function detailsVisit(details: Record<string, unknown>): Visit | null {
  const visit = details.visit
  return visit && typeof visit === 'object' && typeof (visit as { id?: unknown }).id === 'string' ? (visit as Visit) : null
}

function detailsOptions(details: Record<string, unknown>): CheckInOption[] {
  const options = details.check_in_options
  if (!Array.isArray(options)) return []
  return options.filter((option): option is CheckInOption => option === 'MANUAL' || option === 'OVERRIDE')
}

export function outcomeFromScanError(error: unknown): ScanOutcome {
  if (!isApiError(error)) return { kind: 'failed', error }
  // The message in the UI language (the server's in English, the catalog's for its code in Arabic).
  if (error.code === 'PASS_INVALID') return { kind: 'invalid', message: getErrorMessage(error) }
  if (isRefusalCode(error.code)) {
    const visit = detailsVisit(error.details)
    return {
      kind: 'refused',
      code: error.code,
      message: getErrorMessage(error),
      visit,
      // A check-in needs the visit it applies to.
      options: visit ? detailsOptions(error.details) : [],
    }
  }
  return { kind: 'failed', error }
}

/** §10: a check-out of a visitor checked in less than 5 minutes ago needs a confirmation. */
export const RECENT_CHECK_IN_MS = 5 * 60_000

export type PrimaryAction = 'check-in' | 'check-out'

export interface ScanResultActions {
  /** The one action Enter triggers (§10); null when the result offers none. */
  primary: PrimaryAction | null
  /** Check-out offered only as a secondary action that asks for confirmation (checked in < 5 min ago). */
  confirmCheckOut: boolean
  /** "Verify ID & check in" (MANUAL). */
  manualCheckIn: boolean
  /** "Check in anyway" (OVERRIDE, reason required). */
  overrideCheckIn: boolean
  /** "Check again": send the same input once more (the scan got no verdict). */
  retry: boolean
}

const NO_ACTIONS: ScanResultActions = {
  primary: null,
  confirmCheckOut: false,
  manualCheckIn: false,
  overrideCheckIn: false,
  retry: false,
}

/** Whether the visit was checked in less than {@link RECENT_CHECK_IN_MS} before `now`. */
export function isRecentCheckIn(visit: Pick<Visit, 'check_in_at'>, now: number): boolean {
  if (!visit.check_in_at) return false
  const checkedInAt = Date.parse(visit.check_in_at)
  return !Number.isNaN(checkedInAt) && now - checkedInAt < RECENT_CHECK_IN_MS
}

/** The actions the result panel offers (§10 "one primary action"). */
export function scanResultActions(outcome: ScanOutcome, now: number): ScanResultActions {
  switch (outcome.kind) {
    case 'ready':
      return { ...NO_ACTIONS, primary: outcome.canCheckIn ? 'check-in' : null }
    case 'inside':
      if (!outcome.canCheckOut) return NO_ACTIONS
      // Probably the same visitor scanning twice on the way in: never a one-key check-out.
      if (isRecentCheckIn(outcome.visit, now)) return { ...NO_ACTIONS, confirmCheckOut: true }
      return { ...NO_ACTIONS, primary: 'check-out' }
    case 'refused':
      return {
        ...NO_ACTIONS,
        manualCheckIn: outcome.options.includes('MANUAL'),
        overrideCheckIn: outcome.options.includes('OVERRIDE'),
      }
    case 'invalid':
      return NO_ACTIONS
    case 'failed':
      return { ...NO_ACTIONS, retry: true }
  }
}

/** A scan warning as the result panel shows it. */
export interface ScanNotice {
  key: string
  /** `info` for the harmless case (a visitor early inside the pass window), `warning` otherwise. */
  tone: 'info' | 'warning'
  /** "Early: scheduled 11:35–13:05 (starts in 10m)". */
  text: string
  /**
   * The same fact for the live region, without the part that changes every minute: the
   * region would otherwise speak again while the result is shown.
   */
  spoken: string
}

/**
 * The warnings of a READY or ALREADY_CHECKED_IN result, worded from the visit's own times.
 * `OUTSIDE_SCHEDULED_TIME` says whether the visitor is early or late and by how much: early
 * (inside the pass window, the most common harmless case) is information, late is a warning.
 * `OVERSTAYED` of a visitor inside is left out: the panel shows it as the "Overdue · due out"
 * flag every list uses (`InsideFlagBadges`). Any other warning keeps the server's message.
 */
export function scanNotices(outcome: Extract<ScanOutcome, { kind: 'ready' | 'inside' }>, now: number, timeZone: string): ScanNotice[] {
  const { visit } = outcome
  const notices: ScanNotice[] = []
  for (const warning of outcome.warnings) {
    if (warning.code === 'OVERSTAYED' && outcome.kind === 'inside') continue
    if (warning.code === 'OUTSIDE_SCHEDULED_TIME') {
      const start = Date.parse(visit.scheduled_start)
      const end = Date.parse(visit.scheduled_end)
      const range = formatTimeRange(visit.scheduled_start, visit.scheduled_end, timeZone)
      if (now < start) {
        const startsIn = formatIn(secondsBetween(now, start))
        notices.push({
          key: warning.code,
          tone: 'info',
          text: t('scan.notices.early', { range, startsIn }),
          spoken: t('scan.notices.earlySpoken', { range }),
        })
        continue
      }
      if (now > end) {
        const endedAgo = formatAgo(secondsBetween(end, now))
        notices.push({
          key: warning.code,
          tone: 'warning',
          text: t('scan.notices.late', { range, endedAgo }),
          spoken: t('scan.notices.lateSpoken', { range }),
        })
        continue
      }
      // The server judged with its own clock; inside the scheduled time by this one, its words stand.
    }
    // The server's words in English; in Arabic the catalog's for the warning codes it knows.
    const text = (currentLanguage() === 'en' ? null : catalogText('reception', `scan.warnings.${warning.code}`)) ?? warning.message
    notices.push({ key: warning.code, tone: 'warning', text, spoken: text })
  }
  return notices
}

/** A walk-in registration suggested as the way forward, built from the scanned visit where it helps. */
export interface WalkInSuggestion {
  visit: Visit | null
  /** Keep the visit's host (not when the host is the problem). */
  withHost: boolean
  reason: WalkInReason | null
}

export interface RefusalGuidance {
  /**
   * What happened, with the facts the server's message leaves out (when, who): "Pass expired
   * at 10:45". The verdict shows it alone. Null for an invalid pass, whose own message is short
   * enough to be the title.
   */
  title: string | null
  /** `warning` when a check-in is still possible, `danger` when the pass cannot be used. */
  tone: 'warning' | 'danger'
  walkIn: WalkInSuggestion | null
}

/**
 * "at 10:45" on the company-local day of `now`, "on Mon, 5 Oct 2026, 10:45" on another
 * («الساعة 10:45» / «يوم الاثنين، 5 تشرين الأول 2026 الساعة 10:45»).
 */
function atTime(value: string, now: number, timeZone: string): string {
  const moment = momentOnDay(value, now, timeZone)
  return moment.sameDay ? t('scan.atTime', { time: moment.time }) : t('scan.onDay', { date: moment.date, time: moment.time })
}

/**
 * The title of a refusal: the situation with its time (or who). It replaces the server's message,
 * which only restated it ("Visit cancelled by Yara Haddad" over "This visit has been cancelled.")
 * or added advice the panel's actions give (decision 3). Without the visit, the bare situation.
 */
function refusalTitle(outcome: Extract<ScanOutcome, { kind: 'refused' }>, now: number, timeZone: string): string {
  const { visit } = outcome
  switch (outcome.code) {
    case 'VISIT_CANCELLED':
      return visit?.cancelled_by ? t('scan.refusal.cancelledBy', { name: visit.cancelled_by.full_name }) : t('scan.refusal.cancelled')
    case 'VISIT_COMPLETED':
      return visit?.check_out_at ? t('scan.refusal.checkedOutAt', { when: atTime(visit.check_out_at, now, timeZone) }) : t('scan.refusal.completed')
    case 'HOST_INACTIVE':
      return visit ? t('scan.refusal.hostInactiveNamed', { name: visit.host.full_name }) : t('scan.refusal.hostInactive')
    case 'PASS_REVOKED':
      return visit?.pass.issued_at ? t('scan.refusal.replacedAt', { when: atTime(visit.pass.issued_at, now, timeZone) }) : t('scan.refusal.replaced')
    case 'PASS_EXPIRED':
      return visit ? t('scan.refusal.expiredAt', { when: atTime(visit.window_end, now, timeZone) }) : t('scan.refusal.expired')
    case 'PASS_NOT_YET_VALID':
      return visit ? t('scan.refusal.validFrom', { time: formatTimeOnDay(visit.window_start, now, timeZone) }) : t('scan.refusal.notYetValid')
  }
}

const WALK_IN_REASON_FOR: Partial<Record<ScanRefusalCode, WalkInReason>> = {
  PASS_EXPIRED: 'LATE_ARRIVAL',
  PASS_NOT_YET_VALID: 'EARLY_ARRIVAL',
}

/**
 * How the result panel shows a refused or invalid pass (§10): one title with the facts (an
 * invalid pass: the server's message); the next step is the panel's actions, without a sentence
 * of its own (decision 3 of the brand pass: no explanatory notes or subtitles). A walk-in is suggested when no check-in
 * of the visit is possible; it is pre-filled with the visitor, the purpose and (unless the host
 * is inactive) the host, and with the reason where the refusal implies one.
 */
export function refusalGuidance(outcome: Extract<ScanOutcome, { kind: 'refused' | 'invalid' }>, now: number, timeZone: string): RefusalGuidance {
  if (outcome.kind === 'invalid') {
    return {
      title: null,
      tone: 'danger',
      walkIn: { visit: null, withHost: false, reason: null },
    }
  }
  const canCheckIn = outcome.options.length > 0
  return {
    title: refusalTitle(outcome, now, timeZone),
    tone: canCheckIn ? 'warning' : 'danger',
    walkIn: canCheckIn
      ? null
      : { visit: outcome.visit, withHost: outcome.code !== 'HOST_INACTIVE', reason: WALK_IN_REASON_FOR[outcome.code] ?? null },
  }
}

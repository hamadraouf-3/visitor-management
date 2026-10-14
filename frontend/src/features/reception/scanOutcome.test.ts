import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import { i18n } from '../../i18n'
import type { ScanErrorDetails, Visit } from '../../types/api'
import { scanAnnouncement } from './scanAnnouncement'
import {
  isRecentCheckIn,
  outcomeFromScanError,
  outcomeFromScanResult,
  RECENT_CHECK_IN_MS,
  refusalGuidance,
  scanNotices,
  scanResultActions,
  type ScanOutcome,
} from './scanOutcome'
import { insideScan, insideVisit, PASS_TOKEN, readyScan, RECEPTION_NOW, receptionVisit } from './testing/receptionFixtures'
import { walkInPrefillFromVisit } from './walkInForm'

const NOW = RECEPTION_NOW.getTime()
const ZONE = 'Asia/Amman'
const OUTSIDE_SCHEDULED_TIME = { code: 'OUTSIDE_SCHEDULED_TIME', message: 'Visitor is outside the scheduled visit time.' } as const
const OVERSTAYED = { code: 'OVERSTAYED', message: 'Visitor has stayed past the scheduled end time.' } as const

function scanError(status: number, code: string, message: string, details: ScanErrorDetails | Record<string, unknown> = {}) {
  return new ApiError({ status, code, message, details: details as Record<string, unknown> })
}

describe('outcomeFromScanResult / outcomeFromScanError', () => {
  it('turns READY and ALREADY_CHECKED_IN into the two 200 outcomes', () => {
    expect(outcomeFromScanResult(readyScan())).toMatchObject({ kind: 'ready', canCheckIn: true })
    expect(outcomeFromScanResult(insideScan())).toMatchObject({ kind: 'inside', canCheckOut: true })
  })

  it('reads the visit and the check-in options of a refusal (§6 rows 2–8)', () => {
    const visit = receptionVisit({ status: 'NO_SHOW' })
    const outcome = outcomeFromScanError(
      scanError(410, 'PASS_EXPIRED', 'This visitor pass has expired.', { visit, check_in_options: ['OVERRIDE'] }),
    )
    expect(outcome).toEqual({ kind: 'refused', code: 'PASS_EXPIRED', message: 'This visitor pass has expired.', visit, options: ['OVERRIDE'] })
  })

  it('drops options it does not know, and all options when the visit is missing', () => {
    const visit = receptionVisit()
    expect(outcomeFromScanError(scanError(410, 'PASS_REVOKED', 'Replaced.', { visit, check_in_options: ['MANUAL', 'TELEPORT'] }))).toMatchObject({
      options: ['MANUAL'],
    })
    expect(outcomeFromScanError(scanError(410, 'PASS_REVOKED', 'Replaced.', { check_in_options: ['MANUAL'] }))).toMatchObject({
      visit: null,
      options: [],
    })
  })

  it('treats PASS_INVALID as an invalid pass and anything else as no verdict', () => {
    expect(outcomeFromScanError(scanError(404, 'PASS_INVALID', 'Invalid visitor pass.'))).toEqual({ kind: 'invalid', message: 'Invalid visitor pass.' })
    const limited = scanError(429, 'RATE_LIMITED', 'Too many requests. Please wait and try again.')
    expect(outcomeFromScanError(limited)).toEqual({ kind: 'failed', error: limited })
    const network = new Error('offline')
    expect(outcomeFromScanError(network)).toEqual({ kind: 'failed', error: network })
  })
})

describe('scanResultActions (§10 one primary action)', () => {
  it('READY: Check in is the primary action', () => {
    expect(scanResultActions(outcomeFromScanResult(readyScan()), NOW)).toMatchObject({ primary: 'check-in', confirmCheckOut: false })
  })

  it('ALREADY_CHECKED_IN long enough ago: Check out is the primary action', () => {
    // Checked in at 09:02, now 09:10 (8 min).
    expect(scanResultActions(outcomeFromScanResult(insideScan()), NOW)).toMatchObject({ primary: 'check-out', confirmCheckOut: false })
  })

  it('ALREADY_CHECKED_IN less than 5 minutes ago: no primary action, check-out only with a confirmation', () => {
    const visit = insideVisit({ check_in_at: new Date(NOW - RECENT_CHECK_IN_MS + 1_000).toISOString() })
    expect(scanResultActions(outcomeFromScanResult(insideScan(visit)), NOW)).toMatchObject({ primary: null, confirmCheckOut: true })
    // Exactly 5 minutes: no longer recent.
    const fiveMinutes = insideVisit({ check_in_at: new Date(NOW - RECENT_CHECK_IN_MS).toISOString() })
    expect(scanResultActions(outcomeFromScanResult(insideScan(fiveMinutes)), NOW)).toMatchObject({ primary: 'check-out' })
  })

  it('offers nothing the server does not allow', () => {
    expect(scanResultActions({ kind: 'ready', visit: receptionVisit(), warnings: [], canCheckIn: false }, NOW).primary).toBeNull()
    expect(scanResultActions({ kind: 'inside', visit: insideVisit(), warnings: [], canCheckOut: false }, NOW)).toMatchObject({
      primary: null,
      confirmCheckOut: false,
    })
  })

  it('refused passes offer the server’s check-in options; failures offer a retry', () => {
    const refused: ScanOutcome = { kind: 'refused', code: 'PASS_REVOKED', message: 'Replaced.', visit: receptionVisit(), options: ['MANUAL'] }
    expect(scanResultActions(refused, NOW)).toMatchObject({ primary: null, manualCheckIn: true, overrideCheckIn: false })
    expect(scanResultActions({ ...refused, options: ['OVERRIDE'] }, NOW)).toMatchObject({ manualCheckIn: false, overrideCheckIn: true })
    expect(scanResultActions({ kind: 'failed', error: new Error('x') }, NOW)).toMatchObject({ primary: null, retry: true })
    expect(scanResultActions({ kind: 'invalid', message: 'Invalid visitor pass.' }, NOW)).toMatchObject({ primary: null, retry: false })
  })

  it('isRecentCheckIn is false without a check-in time', () => {
    expect(isRecentCheckIn({ check_in_at: null }, NOW)).toBe(false)
  })
})

describe('refusalGuidance', () => {
  const visit = receptionVisit()
  const refused = (code: Extract<ScanOutcome, { kind: 'refused' }>['code'], options: ('MANUAL' | 'OVERRIDE')[] = []) =>
    ({ kind: 'refused', code, message: 'Server message.', visit, options }) as const

  it('names completed and cancelled visits and suggests a walk-in with the same host, without a sentence of advice', () => {
    expect(refusalGuidance(refused('VISIT_COMPLETED'), NOW, ZONE)).toMatchObject({
      title: 'Visit already completed',
      tone: 'danger',
      walkIn: { visit, withHost: true, reason: null },
    })
    expect(refusalGuidance(refused('VISIT_CANCELLED'), NOW, ZONE)).toMatchObject({ title: 'Visit cancelled', tone: 'danger' })
    expect(Object.keys(refusalGuidance(refused('VISIT_COMPLETED'), NOW, ZONE)).toSorted()).toEqual(['title', 'tone', 'walkIn'])
  })

  it('suggests a walk-in without the inactive host', () => {
    expect(refusalGuidance(refused('HOST_INACTIVE'), NOW, ZONE)).toMatchObject({ title: 'Host no longer active: Omar Khalil', walkIn: { withHost: false } })
  })

  it('suggests no walk-in while a check-in of the visit is possible', () => {
    expect(refusalGuidance(refused('PASS_EXPIRED', ['OVERRIDE']), NOW, ZONE)).toMatchObject({ tone: 'warning', walkIn: null })
    expect(refusalGuidance(refused('PASS_REVOKED', ['MANUAL']), NOW, ZONE)).toMatchObject({ walkIn: null })
  })

  it('pre-fills the walk-in reason when the refusal implies it (another day)', () => {
    expect(refusalGuidance(refused('PASS_EXPIRED'), NOW, ZONE).walkIn?.reason).toBe('LATE_ARRIVAL')
    expect(refusalGuidance(refused('PASS_NOT_YET_VALID'), NOW, ZONE).walkIn?.reason).toBe('EARLY_ARRIVAL')
  })

  it('turns the suggestion into a walk-in prefill with visitor, host (to look up), department and purpose', () => {
    const suggestion = refusalGuidance(refused('VISIT_CANCELLED'), NOW, ZONE).walkIn!
    expect(walkInPrefillFromVisit(suggestion.visit, suggestion)).toEqual({
      visitorId: visit.visitor.id,
      purpose: visit.purpose,
      hostRef: { id: visit.host.id, full_name: visit.host.full_name },
      department: visit.department,
    })
  })

  it('titles a refusal with the facts the server’s message leaves out, so the two never repeat each other', () => {
    const title = (code: Parameters<typeof refused>[0], overrides: Partial<Visit> = {}, now = NOW) =>
      refusalGuidance({ ...refused(code), visit: { ...visit, ...overrides } }, now, ZONE).title
    // The default visit's pass window is 08:00–11:00 Amman on Tue 6 Oct.
    expect(title('PASS_EXPIRED')).toBe('Pass expired at 11:00')
    expect(title('PASS_EXPIRED', {}, Date.parse('2026-10-07T06:00:00Z'))).toBe('Pass expired on Tue, 6 Oct 2026, 11:00')
    expect(title('PASS_NOT_YET_VALID')).toBe('Pass valid from 08:00')
    expect(title('VISIT_COMPLETED', { check_out_at: '2026-10-06T07:00:00Z' })).toBe('Checked out at 10:00')
    expect(title('VISIT_CANCELLED', { cancelled_by: { id: 'u1', full_name: 'Omar Khalil' } })).toBe('Visit cancelled by Omar Khalil')
    expect(title('PASS_REVOKED', { pass: { status: 'ACTIVE', issued_at: '2026-10-06T05:40:00Z', revoke_reason: null } })).toBe('Pass replaced at 08:40')
    // Without the visit: the situation alone.
    expect(refusalGuidance({ ...refused('PASS_EXPIRED'), visit: null }, NOW, ZONE).title).toBe('Pass expired')
  })

  /** A refusal's title with its no-break spaces read as spaces. */
  const plainTitle = (code: Parameters<typeof refused>[0], overrides: Partial<Visit> = {}, now = NOW) =>
    refusalGuidance({ ...refused(code), visit: { ...visit, ...overrides } }, now, ZONE).title?.replaceAll('\u00a0', ' ')

  it('words the titles in Arabic without gender and without «الساعة» before a date (review)', async () => {
    const title = plainTitle
    await i18n.changeLanguage('ar')
    try {
      expect(title('PASS_EXPIRED')).toBe('انتهت صلاحية البطاقة الساعة 11:00')
      // On another day: «يوم» and the date, then «الساعة» and the time.
      expect(title('PASS_EXPIRED', {}, Date.parse('2026-10-07T06:00:00Z'))).toBe('انتهت صلاحية البطاقة يوم الثلاثاء، 6 تشرين الأول 2026 الساعة 11:00')
      expect(title('VISIT_COMPLETED', { check_out_at: '2026-10-06T07:00:00Z' })).toBe('سُجّل الخروج الساعة 10:00')
      // A woman's name reads as naturally as a man's: no verb that agrees with the person.
      expect(title('VISIT_CANCELLED', { cancelled_by: { id: 'u1', full_name: 'لينا صالح' } })).toBe('أُلغيت الزيارة بواسطة لينا صالح')
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('offers an invalid pass a walk-in, the server’s message as its title', () => {
    expect(refusalGuidance({ kind: 'invalid', message: 'Invalid visitor pass.' }, NOW, ZONE)).toMatchObject({
      title: null,
      tone: 'danger',
      walkIn: { visit: null },
    })
  })
})

describe('scanAnnouncement', () => {
  const submission = { id: 1, payload: PASS_TOKEN, source: 'camera' as const }

  it('says what happened in one sentence', () => {
    expect(scanAnnouncement({ step: 'ready' }, NOW, ZONE)).toBe('')
    expect(scanAnnouncement({ step: 'validating', submission }, NOW, ZONE)).toBe('Checking the pass…')
    expect(scanAnnouncement({ step: 'result', submission, outcome: outcomeFromScanResult(readyScan()), actionError: null, shownAt: NOW }, NOW, ZONE)).toBe(
      'Ready to check in Élodie Martin. Verify ID.',
    )
    expect(scanAnnouncement({ step: 'success', submission, visit: insideVisit(), completed: 'checked-in' }, NOW, ZONE)).toBe('Élodie Martin checked in.')
    const expired: ScanOutcome = { kind: 'refused', code: 'PASS_EXPIRED', message: 'This visitor pass has expired.', visit: null, options: [] }
    // The verdict's title, as the panel shows it: the server's message only restated it.
    expect(scanAnnouncement({ step: 'result', submission, outcome: expired, actionError: null, shownAt: NOW }, NOW, ZONE)).toBe('Pass expired')
    const invalid: ScanOutcome = { kind: 'invalid', message: 'Invalid visitor pass.' }
    expect(scanAnnouncement({ step: 'result', submission, outcome: invalid, actionError: null, shownAt: NOW }, NOW, ZONE)).toBe('Invalid visitor pass.')
  })

  it('reads the early/late wording without the minutes that change while the result is shown, and a failed action’s message', () => {
    const early = outcomeFromScanResult(readyScan(earlyVisit(), [OUTSIDE_SCHEDULED_TIME]))
    const spoken = 'Ready to check in Élodie Martin. Verify ID. Early: scheduled 09:20–\u206010:50.'
    expect(scanAnnouncement({ step: 'result', submission, outcome: early, actionError: null, shownAt: NOW }, NOW, ZONE)).toBe(spoken)
    expect(scanAnnouncement({ step: 'result', submission, outcome: early, actionError: null, shownAt: NOW }, NOW + 5 * 60_000, ZONE)).toBe(spoken)
    const conflict = new ApiError({ status: 409, code: 'VISIT_ALREADY_CHECKED_IN', message: 'This visitor is already checked in.' })
    expect(scanAnnouncement({ step: 'result', submission, outcome: early, actionError: conflict, shownAt: NOW }, NOW, ZONE)).toBe('This visitor is already checked in.')
  })

  it('names an overdue visitor inside with the list’s flag, not the server’s sentence', () => {
    const overdue = outcomeFromScanResult(insideScan(overdueVisit(), [OVERSTAYED]))
    expect(scanAnnouncement({ step: 'result', submission, outcome: overdue, actionError: null, shownAt: NOW }, NOW, ZONE)).toBe(
      'Élodie Martin is already checked in. Overdue · due out 09:05.',
    )
  })
})

/** Scheduled 09:20–10:50 Amman: ten minutes after NOW (09:10), inside the pass window. */
function earlyVisit() {
  return receptionVisit({ scheduled_start: '2026-10-06T06:20:00Z', scheduled_end: '2026-10-06T07:50:00Z' })
}

/** Checked in at 08:02, due out at 09:05 Amman: overdue at NOW (09:10). */
function overdueVisit() {
  return insideVisit({
    check_in_at: '2026-10-06T05:02:00Z',
    scheduled_start: '2026-10-06T05:00:00Z',
    scheduled_end: '2026-10-06T06:05:00Z',
    is_overdue: true,
  })
}

describe('scanNotices (the warnings worded from the visit’s times)', () => {
  it('says an early visitor inside the pass window is early, when the visit is and how soon it starts, as information', () => {
    expect(scanNotices(outcomeFromScanResult(readyScan(earlyVisit(), [OUTSIDE_SCHEDULED_TIME])), NOW, ZONE)).toEqual([
      { key: 'OUTSIDE_SCHEDULED_TIME', tone: 'info', text: 'Early: scheduled 09:20–\u206010:50 (starts in 10m)', spoken: 'Early: scheduled 09:20–\u206010:50.' },
    ])
  })

  it('says a late visitor is late, as a warning', () => {
    // Scheduled 07:30–08:40; the pass is valid until 09:40.
    const late = receptionVisit({
      scheduled_start: '2026-10-06T04:30:00Z',
      scheduled_end: '2026-10-06T05:40:00Z',
      window_start: '2026-10-06T03:30:00Z',
      window_end: '2026-10-06T06:40:00Z',
    })
    expect(scanNotices(outcomeFromScanResult(readyScan(late, [OUTSIDE_SCHEDULED_TIME])), NOW, ZONE)).toEqual([
      { key: 'OUTSIDE_SCHEDULED_TIME', tone: 'warning', text: 'Late: scheduled 07:30–\u206008:40 (ended 30m ago)', spoken: 'Late: scheduled 07:30–\u206008:40.' },
    ])
  })

  it('keeps the server’s words when this clock puts the visitor inside the scheduled time, and for codes it does not know', () => {
    // The default visit is 09:00–10:00 and NOW is 09:10: the server's clock disagreed.
    const skewed = scanNotices(outcomeFromScanResult(readyScan(receptionVisit(), [OUTSIDE_SCHEDULED_TIME])), NOW, ZONE)
    expect(skewed).toEqual([{ key: 'OUTSIDE_SCHEDULED_TIME', tone: 'warning', text: OUTSIDE_SCHEDULED_TIME.message, spoken: OUTSIDE_SCHEDULED_TIME.message }])
  })

  it('leaves OVERSTAYED of a visitor inside to the "Overdue · due out" flag', () => {
    expect(scanNotices(outcomeFromScanResult(insideScan(overdueVisit(), [OVERSTAYED])), NOW, ZONE)).toEqual([])
  })
})

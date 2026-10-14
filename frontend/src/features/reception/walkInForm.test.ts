import { describe, expect, it } from 'vitest'
import { makeHost, makeVisitor } from '../../test/fixtures'
import { inviteDepartmentChoice } from '../visits/inviteForm'
import { RECEPTION_NOW, receptionVisit } from './testing/receptionFixtures'
import {
  hasContactDetails,
  initialWalkInValues,
  toWalkInCreate,
  validateWalkIn,
  WALK_IN_MESSAGES,
  WALK_IN_REASON_OPTIONS,
  WALK_IN_REASONS,
  walkInExpectedEnd,
  walkInPrefillFromVisit,
  walkInStayOptions,
  withWalkInDepartment,
  withWalkInHost,
  withWalkInStay,
  type WalkInFormValues,
} from './walkInForm'

/** Tue 6 Oct 2026, 09:10 Amman (UTC+3). */
const NOW = RECEPTION_NOW.getTime()
const ZONE = 'Asia/Amman'
const HOST = makeHost()
/** 16:40 Amman: twenty minutes before the office day ends. */
const LATE_AFTERNOON = Date.parse('2026-10-06T13:40:00Z')

function returning(overrides: Partial<WalkInFormValues> = {}): WalkInFormValues {
  return {
    ...initialWalkInValues({ visitor: makeVisitor(), host: HOST }),
    purpose: 'Contract signing',
    reason: 'NO_INVITATION',
    ...overrides,
  }
}

describe('walk-in defaults', () => {
  it('stays one hour (§8.1) and starts without a reason', () => {
    const values = initialWalkInValues()
    expect(values.stay).toBe('1h')
    expect(values.expectedEnd).toBeNull()
    expect(values.reason).toBeNull()
    expect(values.existingVisitor).toBeNull()
    expect(values.host).toBeNull()
  })

  it('takes a prefill: visitor, host with their department, purpose and reason', () => {
    const values = initialWalkInValues({ visitor: makeVisitor(), host: HOST, purpose: 'Delivery', reason: 'DELIVERY' })
    expect(values).toMatchObject({ purpose: 'Delivery', reason: 'DELIVERY', departmentId: HOST.department?.id })
    expect(values.existingVisitor?.id).toBe(makeVisitor().id)
  })

  it('offers the six reasons of §8.1 with readable labels', () => {
    expect(WALK_IN_REASONS).toEqual(['NO_INVITATION', 'EARLY_ARRIVAL', 'LATE_ARRIVAL', 'LOST_PASS', 'DELIVERY', 'OTHER'])
    expect(WALK_IN_REASON_OPTIONS.map((option) => option.label)).toEqual([
      'No invitation',
      'Early arrival',
      'Late arrival',
      'Lost pass',
      'Delivery',
      'Other',
    ])
  })
})

describe('how long a walk-in stays', () => {
  it('offers quick lengths, the end of the office day while 30 minutes or more of it are left, and "Other…"', () => {
    expect(walkInStayOptions(NOW, ZONE).map((option) => option.label)).toEqual(['30 min', '1 hour', '2 hours', 'Until 17:00', 'Other…'])
    expect(walkInStayOptions(LATE_AFTERNOON, ZONE).map((option) => option.value)).toEqual(['30m', '1h', '2h', 'other'])
    // Still listed while it is the one chosen.
    expect(walkInStayOptions(LATE_AFTERNOON, ZONE, 'office-day').map((option) => option.value)).toContain('office-day')
  })

  it('turns the pick into the expected end, counted from the moment given (the form sends it then)', () => {
    expect(walkInExpectedEnd({ stay: '30m', expectedEnd: null }, NOW, ZONE)).toBe('2026-10-06T06:40:00.000Z')
    expect(walkInExpectedEnd({ stay: '1h', expectedEnd: null }, NOW, ZONE)).toBe('2026-10-06T07:10:00.000Z')
    expect(walkInExpectedEnd({ stay: '2h', expectedEnd: null }, NOW, ZONE)).toBe('2026-10-06T08:10:00.000Z')
    // 17:00 in Amman, whatever the browser's time zone.
    expect(walkInExpectedEnd({ stay: 'office-day', expectedEnd: null }, NOW, ZONE)).toBe('2026-10-06T14:00:00.000Z')
    expect(walkInExpectedEnd({ stay: 'other', expectedEnd: '2026-10-07T09:00:00.000Z' }, NOW, ZONE)).toBe('2026-10-07T09:00:00.000Z')
    expect(walkInExpectedEnd({ stay: 'other', expectedEnd: null }, NOW, ZONE)).toBeNull()
  })

  it('starts "Other…" at the end picked so far, and keeps a date and time already chosen', () => {
    expect(withWalkInStay(returning({ stay: '2h' }), 'other', NOW, ZONE)).toMatchObject({ stay: 'other', expectedEnd: '2026-10-06T08:10:00.000Z' })
    const chosen = returning({ stay: '30m', expectedEnd: '2026-10-07T09:00:00.000Z' })
    expect(withWalkInStay(chosen, 'other', NOW, ZONE).expectedEnd).toBe('2026-10-07T09:00:00.000Z')
    expect(withWalkInStay(chosen, '1h', NOW, ZONE)).toMatchObject({ stay: '1h' })
  })
})

describe('validateWalkIn', () => {
  it('needs only visitor, host, purpose and reason from a returning visitor (≤ 4 inputs, §10)', () => {
    expect(validateWalkIn(returning(), NOW, ZONE)).toEqual({})
  })

  it('needs the new visitor’s name, a host, a purpose, a reason and an end under "Other…"', () => {
    const errors = validateWalkIn({ ...initialWalkInValues(), stay: 'other', expectedEnd: null }, NOW, ZONE)
    expect(errors).toEqual({
      // The visitor fields' own wording (features/visitors) is not pinned here.
      fullName: expect.stringMatching(/full name/),
      host: WALK_IN_MESSAGES.host,
      purpose: WALK_IN_MESSAGES.purpose,
      expectedEnd: WALK_IN_MESSAGES.expectedEndMissing,
      reason: WALK_IN_MESSAGES.reason,
    })
  })

  it('keeps the expected end after now and within 24 hours', () => {
    expect(validateWalkIn(returning({ stay: 'other', expectedEnd: new Date(NOW).toISOString() }), NOW, ZONE).expectedEnd).toBe(
      WALK_IN_MESSAGES.expectedEndPast,
    )
    expect(validateWalkIn(returning({ stay: 'other', expectedEnd: new Date(NOW + 24 * 3_600_000 + 60_000).toISOString() }), NOW, ZONE).expectedEnd).toBe(
      WALK_IN_MESSAGES.expectedEndTooLate,
    )
    // "Until 17:00" picked earlier, sent after 17:00.
    expect(validateWalkIn(returning({ stay: 'office-day' }), Date.parse('2026-10-06T14:05:00Z'), ZONE).expectedEnd).toBe(WALK_IN_MESSAGES.expectedEndPast)
  })

  it('requires a note for "Other"', () => {
    expect(validateWalkIn(returning({ reason: 'OTHER' }), NOW, ZONE).reasonNote).toBe(WALK_IN_MESSAGES.reasonNote)
    // A note, a purpose or a new visitor's name made only of invisible characters says nothing.
    expect(validateWalkIn(returning({ reason: 'OTHER', reasonNote: '\ufeff' }), NOW, ZONE).reasonNote).toBe(WALK_IN_MESSAGES.reasonNote)
    expect(validateWalkIn(returning({ purpose: '\u200b' }), NOW, ZONE).purpose).toBe(WALK_IN_MESSAGES.purpose)
    expect(validateWalkIn(returning({ reason: 'OTHER', reasonNote: 'Meeting the auditors' }), NOW, ZONE)).toEqual({})
  })

  it('checks a new visitor’s email format and lengths', () => {
    const errors = validateWalkIn(returning({ existingVisitor: null, fullName: 'Sami Odeh', email: 'not-an-address', purpose: 'x'.repeat(501) }), NOW, ZONE)
    expect(errors).toEqual({ email: expect.stringMatching(/valid email/), purpose: 'Enter at most 500 characters.' })
  })
})

describe('new visitor contact details', () => {
  it('are shown once any of them holds text', () => {
    expect(hasContactDetails({ companyName: '', phone: ' ', email: '' })).toBe(false)
    expect(hasContactDetails({ companyName: '', phone: '079 555 0101', email: '' })).toBe(true)
  })
})

describe('toWalkInCreate', () => {
  it('sends a returning visitor by id; the host’s own department is left to the server (B24-23)', () => {
    expect(toWalkInCreate(returning(), NOW, ZONE)).toEqual({
      visitor_id: makeVisitor().id,
      host_id: HOST.id,
      purpose: 'Contract signing',
      expected_end: '2026-10-06T07:10:00.000Z',
      reason: 'NO_INVITATION',
    })
  })

  it('sends a new visitor with only the filled fields, another department, and the note for "Other"', () => {
    const body = toWalkInCreate(
      returning({
        existingVisitor: null,
        fullName: '  Sami Odeh ',
        phone: '079 555 0101',
        departmentId: 'dep-other',
        reason: 'OTHER',
        reasonNote: ' Courier for legal ',
        stay: '2h',
      }),
      NOW,
      ZONE,
    )
    expect(body).toEqual({
      visitor: { full_name: 'Sami Odeh', phone: '079 555 0101' },
      host_id: HOST.id,
      department_id: 'dep-other',
      purpose: 'Contract signing',
      expected_end: '2026-10-06T08:10:00.000Z',
      reason: 'OTHER',
      reason_note: 'Courier for legal',
    })
  })

  it('does not send a note typed for another reason', () => {
    expect(toWalkInCreate(returning({ reason: 'DELIVERY', reasonNote: 'left over' }), NOW, ZONE)).not.toHaveProperty('reason_note')
  })
})

describe('walk-in department', () => {
  it('follows the host', () => {
    const other = makeHost({ id: 'h2', department: { id: 'dep-2', name: 'Sales', name_ar: null } })
    expect(withWalkInHost(returning(), other).departmentId).toBe('dep-2')
    expect(withWalkInHost(returning(), null).host).toBeNull()
  })

  it('offers "No department" only for a host without an active department (the invite form’s rule)', () => {
    const active = new Set([HOST.department!.id])
    expect(inviteDepartmentChoice(returning(), active)).toEqual({ value: HOST.department!.id, allowNone: false, pending: null })
    expect(inviteDepartmentChoice(returning(), new Set())).toEqual({ value: '', allowNone: true, pending: null })
    expect(inviteDepartmentChoice(returning(), undefined).pending).toEqual(HOST.department)
  })

  it('sends a department picked in the field, even the host’s own', () => {
    const picked = withWalkInDepartment(returning(), HOST.department!.id)
    expect(toWalkInCreate(picked, NOW, ZONE).department_id).toBe(HOST.department!.id)
    // Picking a new host takes over the host's department again, which is then left to the server.
    expect(toWalkInCreate(withWalkInHost(picked, HOST), NOW, ZONE)).not.toHaveProperty('department_id')
  })
})

describe('walk-in from a scanned visit', () => {
  const LEGAL = { id: 'dep-legal', name: 'Legal', name_ar: null }
  const SALES = { id: 'dep-sales', name: 'Sales', name_ar: null }
  const host = makeHost({ id: '7f0d1c0e-1111-4a5b-9c1d-000000000077', full_name: 'Omar Khalil', department: SALES })

  it('names the host for a lookup and keeps the visit’s department as a choice', () => {
    const prefill = walkInPrefillFromVisit(receptionVisit({ department: LEGAL }), { withHost: true, reason: 'LATE_ARRIVAL' })
    expect(prefill).toEqual({
      visitorId: receptionVisit().visitor.id,
      purpose: receptionVisit().purpose,
      hostRef: { id: host.id, full_name: 'Omar Khalil' },
      department: LEGAL,
      reason: 'LATE_ARRIVAL',
    })
  })

  it('saves the visit’s department when it is not the host’s (it shows in the form)', () => {
    const prefill = walkInPrefillFromVisit(receptionVisit({ department: LEGAL }), { withHost: true, reason: null })
    // The form fills in the host record it looked up.
    const values = { ...initialWalkInValues(prefill), host, purpose: 'Signing', reason: 'LATE_ARRIVAL' as const }
    expect(inviteDepartmentChoice(values, new Set([LEGAL.id, SALES.id])).value).toBe(LEGAL.id)
    expect(toWalkInCreate(values, NOW, ZONE).department_id).toBe(LEGAL.id)
  })

  it('shows and applies the host’s own department when the visit had none', () => {
    const prefill = walkInPrefillFromVisit(receptionVisit({ department: null }), { withHost: true, reason: null })
    const values = { ...initialWalkInValues(prefill), host, purpose: 'Signing', reason: 'LATE_ARRIVAL' as const }
    const field = inviteDepartmentChoice(values, new Set([SALES.id]))
    expect(field).toMatchObject({ value: SALES.id, allowNone: false })
    // Left out: the server applies the host's department, the one the field shows.
    expect(toWalkInCreate({ ...values, departmentId: field.value }, NOW, ZONE)).not.toHaveProperty('department_id')
  })

  it('keeps neither host nor department when the host is the problem', () => {
    const prefill = walkInPrefillFromVisit(receptionVisit({ department: LEGAL }), { withHost: false, reason: null })
    expect(prefill).not.toHaveProperty('hostRef')
    expect(prefill).not.toHaveProperty('department')
  })
})

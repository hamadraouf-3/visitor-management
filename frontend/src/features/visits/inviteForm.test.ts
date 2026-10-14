import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeMe } from '../../test/api'
import { makeHost, makeSearchItem } from '../../test/fixtures'
import { wallTimeToUtc } from '../../utils/datetime'
import {
  canChooseHost,
  INVITE_MESSAGES,
  initialInviteValues,
  inviteDepartmentChoice,
  passDelivery,
  toVisitCreate,
  validateInvite,
  withHost,
  withStart,
  type InviteFormValues,
} from './inviteForm'
import { SCHEDULE_MESSAGES } from './schedule'

const me = makeMe(['EMPLOYEE']) // company in Asia/Amman (UTC+3), department Finance
const FINANCE_ID = me.user.department!.id
const LEGAL_ID = makeHost().department!.id
// 09:10 on Mon 5 Oct 2026 in Amman.
const NOW = Date.parse('2026-10-05T06:10:00Z')

function validValues(overrides: Partial<InviteFormValues> = {}): InviteFormValues {
  return {
    ...initialInviteValues(me, NOW),
    fullName: 'Élodie Martin',
    email: 'elodie@orbit.example',
    purpose: 'Quarterly review',
    ...overrides,
  }
}

describe('initialInviteValues', () => {
  it('defaults host to me, department to mine, start to the next half hour and end to one hour later', () => {
    const values = initialInviteValues(me, NOW)

    expect(values.host).toEqual({ id: me.user.id, full_name: 'Lina Haddad', phone: null, department: me.user.department })
    expect(values.departmentId).toBe(me.user.department?.id)
    expect(values.start).toBe('2026-10-05T06:30:00.000Z') // 09:30 Amman
    expect(values.end).toBe('2026-10-05T07:30:00.000Z') // 10:30 Amman
    expect(values.sendInvitation).toBe(true)
    expect(passDelivery(values)).toBe('email')
    expect(passDelivery({ sendInvitation: false })).toBe('share')
    expect(values.existingVisitor).toBeNull()
  })

  it('uses the company timezone for the half-hour boundary, not the browser one', () => {
    // Kathmandu is UTC+5:45, so its :00 and :30 fall on :15 and :45 UTC.
    const kathmanduMe = { ...me, company: { ...me.company, timezone: 'Asia/Kathmandu' } }
    // 06:10 UTC = 11:55 local → 12:00 local = 06:15 UTC (rounding in UTC, the browser zone here, would give 06:30).
    const values = initialInviteValues(kathmanduMe, NOW)
    expect(values.start).toBe('2026-10-05T06:15:00.000Z')
    expect(values.end).toBe('2026-10-05T07:15:00.000Z')
  })
})

describe('withHost', () => {
  it('takes the new host’s department, or none', () => {
    const omar = makeHost()
    expect(withHost(validValues(), omar)).toMatchObject({ host: omar, departmentId: omar.department?.id })
    expect(withHost(validValues(), makeHost({ department: null })).departmentId).toBe('')
  })

  it('keeps the department when the host is cleared', () => {
    expect(withHost(validValues(), null)).toMatchObject({ host: null, departmentId: me.user.department?.id })
  })
})

describe('withStart', () => {
  it('keeps the visit length when the start moves', () => {
    const values = validValues({ start: '2026-10-06T06:00:00.000Z', end: '2026-10-06T07:30:00.000Z' }) // 90 minutes
    expect(withStart(values, '2026-10-07T08:00:00.000Z').end).toBe('2026-10-07T09:30:00.000Z')
  })

  it('falls back to one hour when the previous range was unusable', () => {
    expect(withStart(validValues({ start: '2026-10-06T06:00:00.000Z', end: null }), '2026-10-06T08:00:00.000Z').end).toBe(
      '2026-10-06T09:00:00.000Z',
    )
    expect(
      withStart(validValues({ start: '2026-10-06T06:00:00.000Z', end: '2026-10-06T05:00:00.000Z' }), '2026-10-06T08:00:00.000Z').end,
    ).toBe('2026-10-06T09:00:00.000Z')
  })

  it('leaves the end alone when the start is cleared', () => {
    expect(withStart(validValues(), null)).toMatchObject({ start: null, end: '2026-10-05T07:30:00.000Z' })
  })
})

describe('validateInvite', () => {
  it('accepts a complete form', () => {
    expect(validateInvite(validValues(), NOW)).toEqual({})
  })

  it('requires the email only when the invitation is sent', () => {
    expect(validateInvite(validValues({ email: '  ' }), NOW)).toEqual({ email: INVITE_MESSAGES.emailRequiredForInvitation })
    expect(validateInvite(validValues({ email: '', sendInvitation: false }), NOW)).toEqual({})
    // An address that is given must be plausible either way.
    expect(validateInvite(validValues({ email: 'elodie@', sendInvitation: false }), NOW)).toHaveProperty('email')
  })

  it('names the way out in the app’s typographic quotes', () => {
    expect(INVITE_MESSAGES.emailRequiredForInvitation).toBe(
      'Enter the visitor’s email address to email the invitation, or choose “I’ll share the pass myself”.',
    )
    for (const message of [INVITE_MESSAGES.emailRequiredForInvitation, INVITE_MESSAGES.existingVisitorWithoutEmail]) expect(message).not.toMatch(/["']/)
  })

  it('needs an email on file for a returning visitor who gets an invitation', () => {
    const withoutEmail = makeSearchItem({ email: null })
    expect(validateInvite(validValues({ existingVisitor: withoutEmail, fullName: '', email: '' }), NOW)).toEqual({
      existingVisitor: INVITE_MESSAGES.existingVisitorWithoutEmail,
    })
    expect(validateInvite(validValues({ existingVisitor: withoutEmail, fullName: '', sendInvitation: false }), NOW)).toEqual({})
  })

  it('checks the new visitor’s name and field lengths', () => {
    const errors = validateInvite(validValues({ fullName: ' ', phone: '1'.repeat(41), companyName: 'x'.repeat(201) }), NOW)
    expect(errors).toEqual({
      fullName: 'Enter the visitor’s full name.',
      phone: 'Enter at most 40 characters.',
      companyName: 'Enter at most 200 characters.',
    })
  })

  it('requires a host and a purpose of at most 500 characters', () => {
    expect(validateInvite(validValues({ host: null, purpose: '  ' }), NOW)).toEqual({
      host: 'Choose the host of the visit.',
      purpose: 'Enter the purpose of the visit.',
    })
    expect(validateInvite(validValues({ purpose: 'x'.repeat(501) }), NOW)).toEqual({ purpose: 'Enter at most 500 characters.' })
    expect(validateInvite(validValues({ purpose: 'x'.repeat(500) }), NOW)).toEqual({})
  })

  it('mirrors the server schedule rules', () => {
    const at = (start: string, end: string) => validateInvite(validValues({ start, end }), NOW)
    expect(at('2026-10-06T06:00:00Z', '2026-10-06T06:00:00Z')).toEqual({ end: SCHEDULE_MESSAGES.endBeforeStart })
    expect(at('2026-10-06T06:00:00Z', '2026-10-07T06:00:01Z')).toEqual({ end: SCHEDULE_MESSAGES.tooLong })
    expect(at('2026-10-06T06:00:00Z', '2026-10-07T06:00:00Z')).toEqual({})
    // Five minutes of tolerance for a start in the past.
    expect(at('2026-10-05T06:05:00Z', '2026-10-05T07:00:00Z')).toEqual({})
    expect(at('2026-10-05T06:04:59Z', '2026-10-05T07:00:00Z')).toEqual({ start: SCHEDULE_MESSAGES.inPast })
    expect(at('2027-10-06T06:00:00Z', '2027-10-06T07:00:00Z')).toEqual({ start: SCHEDULE_MESSAGES.tooFarAhead })
    expect(validateInvite(validValues({ start: null, end: null }), NOW)).toEqual({
      start: SCHEDULE_MESSAGES.startRequired,
      end: SCHEDULE_MESSAGES.endRequired,
    })
  })
})

function active(...ids: string[]): Set<string> {
  return new Set(ids)
}

describe('inviteDepartmentChoice', () => {
  it('shows the host’s active department and offers no "No department" (the server would apply the host’s anyway)', () => {
    expect(inviteDepartmentChoice(validValues(), active(FINANCE_ID, LEGAL_ID))).toEqual({ value: FINANCE_ID, allowNone: false, pending: null })
    // Nothing chosen still means the host's department.
    expect(inviteDepartmentChoice(validValues({ departmentId: '' }), active(FINANCE_ID)).value).toBe(FINANCE_ID)
  })

  it('falls back to "No department" when the host’s department is inactive, as the server does', () => {
    expect(inviteDepartmentChoice(validValues(), active(LEGAL_ID))).toEqual({ value: '', allowNone: true, pending: null })
    expect(inviteDepartmentChoice(validValues({ host: makeHost({ department: null }), departmentId: '' }), active(LEGAL_ID))).toEqual({
      value: '',
      allowNone: true,
      pending: null,
    })
  })

  it('lists the host’s department while the active departments load', () => {
    expect(inviteDepartmentChoice(validValues(), undefined)).toEqual({ value: FINANCE_ID, allowNone: false, pending: me.user.department })
  })
})

describe('toVisitCreate', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('sends a new visitor inline with empty optional fields left out', () => {
    const body = toVisitCreate(validValues({ fullName: '  Élodie Martin ', email: ' elodie@orbit.example ', purpose: ' Review ' }))
    expect(body).toEqual({
      visitor: { full_name: 'Élodie Martin', email: 'elodie@orbit.example' },
      host_id: me.user.id,
      purpose: 'Review',
      scheduled_start: '2026-10-05T06:30:00.000Z',
      scheduled_end: '2026-10-05T07:30:00.000Z',
      send_invitation: true,
    })
  })

  it('leaves the host’s own department to the server default (B24-23) and sends another one', () => {
    // The default (my department) is what the server applies without a department_id, and
    // it stays correct if that department is deactivated before the request arrives.
    expect(toVisitCreate(validValues())).not.toHaveProperty('department_id')
    expect(toVisitCreate(validValues({ departmentId: LEGAL_ID }))).toHaveProperty('department_id', LEGAL_ID)
  })

  it('sends only the id of a returning visitor, and no department when none is chosen', () => {
    const body = toVisitCreate(validValues({ existingVisitor: makeSearchItem(), departmentId: '', sendInvitation: false }))
    expect(body).not.toHaveProperty('visitor')
    expect(body).not.toHaveProperty('department_id')
    expect(body).toMatchObject({ visitor_id: makeSearchItem().id, send_invitation: false })
  })

  it.each(['America/Los_Angeles', 'Pacific/Auckland'])(
    'sends timezone-aware instants for the company wall time when the browser is in %s',
    (browserZone) => {
      vi.stubEnv('TZ', browserZone)
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(browserZone)

      // What the date-time fields produce for 09:00–10:30 typed in Amman (company) time.
      const start = wallTimeToUtc('2026-10-06T09:00', me.company.timezone)
      const end = wallTimeToUtc('2026-10-06T10:30', me.company.timezone)
      const body = toVisitCreate(validValues({ start, end }))

      expect(body.scheduled_start).toBe('2026-10-06T06:00:00.000Z')
      expect(body.scheduled_end).toBe('2026-10-06T07:30:00.000Z')
      expect(Date.parse(body.scheduled_start)).toBe(Date.UTC(2026, 9, 6, 6, 0))
    },
  )
})

describe('canChooseHost', () => {
  it('lets only an administrator invite for another host (§7.5, phase 10 shared contract A)', () => {
    expect(canChooseHost(makeMe(['SYSTEM_ADMIN']).user)).toBe(true)
    expect(canChooseHost(makeMe(['EMPLOYEE', 'SYSTEM_ADMIN']).user)).toBe(true)
    expect(canChooseHost(makeMe(['EMPLOYEE']).user)).toBe(false)
    expect(canChooseHost(makeMe(['EMPLOYEE', 'MANAGEMENT', 'RECEPTIONIST']).user)).toBe(false)
  })
})

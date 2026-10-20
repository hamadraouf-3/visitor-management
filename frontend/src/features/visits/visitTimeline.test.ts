import { describe, expect, it } from 'vitest'
import { makeVisit } from '../../test/fixtures'
import { buildVisitTimeline } from './visitTimeline'

const RECEPTION = { id: 'r1', full_name: 'Rana Saleh' }

describe('buildVisitTimeline', () => {
  it('lists creation and the sent invitation of a scheduled visit', () => {
    expect(buildVisitTimeline(makeVisit()).map(({ id, title, detail, recipient }) => ({ id, title, detail, recipient }))).toEqual([
      { id: 'created', title: 'Visit created', detail: 'By Lina Haddad', recipient: undefined },
      { id: 'invitation', title: 'Invitation sent', detail: null, recipient: 'elodie@orbit.example' },
    ])
  })

  it('reports a failed invitation at its last attempt and leaves out one still being sent', () => {
    const failed = makeVisit({ invitation: { status: 'FAILED', sent_at: null, last_attempt_at: '2026-10-05T06:10:05Z' } })
    expect(buildVisitTimeline(failed)[1]).toMatchObject({ id: 'invitation', title: 'Invitation could not be sent', tone: 'danger' })
    // Only the calendar invitation that followed it failed: said as such, at its attempt, to its address.
    const calendarFailed = makeVisit({ invitation: { status: 'FAILED', sent_at: null, last_attempt_at: '2026-10-05T06:10:09Z', calendar_failed: true } })
    expect(buildVisitTimeline(calendarFailed)[1]).toMatchObject({
      id: 'invitation',
      at: '2026-10-05T06:10:09Z',
      title: 'Calendar invitation not delivered',
      recipient: 'elodie@orbit.example',
      tone: 'danger',
    })

    const pending = makeVisit({ invitation: { status: 'PENDING', sent_at: null, last_attempt_at: null, attempts: 0 } })
    expect(buildVisitTimeline(pending).map((event) => event.id)).toEqual(['created'])
  })

  it('shows check-in and check-out with method, staff and note, oldest first', () => {
    const visit = makeVisit({
      status: 'CHECKED_OUT',
      check_in_at: '2026-10-06T06:05:00Z',
      check_in_method: 'OVERRIDE',
      check_in_note: 'Arrived early',
      checked_in_by: RECEPTION,
      check_out_at: '2026-10-06T07:10:00Z',
      check_out_method: 'QR',
      checked_out_by: RECEPTION,
    })
    const events = buildVisitTimeline(visit)
    expect(events.map((event) => event.id)).toEqual(['created', 'invitation', 'checked-in', 'checked-out'])
    expect(events[2]).toMatchObject({
      title: 'Checked in by Rana Saleh',
      detail: 'Method: override by reception · Note: Arrived early',
    })
    expect(events[3]).toMatchObject({ title: 'Checked out by Rana Saleh', detail: 'Method: QR code scan' })
  })

  it('shows a cancellation with its reason, or that none was given', () => {
    const cancelled = makeVisit({
      status: 'CANCELLED',
      cancelled_at: '2026-10-05T08:00:00Z',
      cancelled_by: { id: 'u1', full_name: 'Lina Haddad' },
      cancellation_reason: 'Meeting moved online',
    })
    expect(buildVisitTimeline(cancelled).at(-1)).toMatchObject({ title: 'Cancelled by Lina Haddad', detail: 'Reason: Meeting moved online' })
    expect(buildVisitTimeline({ ...cancelled, cancellation_reason: null }).at(-1)?.detail).toBe('No reason given')
  })

  it('reports whether the cancellation email reached the visitor, after the cancellation', () => {
    const cancelled = {
      status: 'CANCELLED',
      cancelled_at: '2026-10-05T08:00:00Z',
      cancelled_by: { id: 'u1', full_name: 'Lina Haddad' },
    } as const
    const notice = { kind: 'VISIT_CANCELLED', to_email: 'elodie@orbit.example', error: null } as const

    const sent = buildVisitTimeline(makeVisit({ ...cancelled, last_notice: { ...notice, status: 'SENT', sent_at: '2026-10-05T08:00:03Z' } }))
    expect(sent.map((event) => event.id)).toEqual(['created', 'invitation', 'cancelled', 'notice'])
    expect(sent.at(-1)).toMatchObject({ title: 'Cancellation email sent', recipient: 'elodie@orbit.example', at: '2026-10-05T08:00:03Z' })

    // Not sent: dated with the cancellation that queued it, and it says what to do.
    const failed = buildVisitTimeline(
      makeVisit({ ...cancelled, last_notice: { ...notice, status: 'FAILED', sent_at: null, error: 'Mailbox unavailable' } }),
    )
    expect(failed.map((event) => event.id)).toEqual(['created', 'invitation', 'cancelled', 'notice'])
    expect(failed.at(-1)).toMatchObject({
      title: 'Cancellation email could not be sent',
      detail: 'The visitor was not told. Let them know yourself.',
      at: '2026-10-05T08:00:00Z',
      tone: 'danger',
    })
  })

  it('places an email about a new time by when it was sent, or before the visit left SCHEDULED', () => {
    const notice = { kind: 'VISIT_RESCHEDULED', to_email: 'elodie@orbit.example', error: null } as const
    const sent = buildVisitTimeline(makeVisit({ last_notice: { ...notice, status: 'SENT', sent_at: '2026-10-05T07:00:00Z' } }))
    expect(sent.at(-1)).toMatchObject({ id: 'notice', title: 'Email about the new time sent' })

    // A failed one has no time on the visit: it comes before the check-in (a reschedule always does).
    const checkedIn = buildVisitTimeline(
      makeVisit({
        status: 'CHECKED_IN',
        check_in_at: '2026-10-06T06:05:00Z',
        check_in_method: 'QR',
        checked_in_by: RECEPTION,
        last_notice: { ...notice, status: 'FAILED', sent_at: null },
      }),
    )
    expect(checkedIn.map((event) => event.id)).toEqual(['created', 'invitation', 'notice', 'checked-in'])
    expect(checkedIn[2]).toMatchObject({ title: 'Email about the new time could not be sent', at: null })
    expect(buildVisitTimeline(makeVisit({ last_notice: { ...notice, status: 'PENDING', sent_at: null } })).at(-1)).toMatchObject({
      title: 'Sending the email about the new time',
      at: null,
    })
  })

  it('shows a no-show and a walk-in registration', () => {
    expect(buildVisitTimeline(makeVisit({ status: 'NO_SHOW', no_show_at: '2026-10-06T08:00:01Z' })).at(-1)).toMatchObject({
      id: 'no-show',
      title: 'Marked as no-show',
      tone: 'warning',
    })
    const walkIn = makeVisit({ is_walk_in: true, walk_in_reason: 'LOST_PASS', invitation: { status: 'NOT_SENT', sent_at: null } })
    expect(buildVisitTimeline(walkIn)[0]).toMatchObject({ title: 'Walk-in registered', detail: 'By Lina Haddad · Reason: Lost pass' })
  })
})

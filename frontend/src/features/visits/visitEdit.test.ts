import { describe, expect, it } from 'vitest'
import { LEGAL, makeVisit } from '../../test/fixtures'
import type { Visit } from '../../types/api'
import { SCHEDULE_MESSAGES } from './schedule'
import {
  cancelEmailsVisitor,
  cancelledMessage,
  cancelNoEmailNotice,
  editValuesFromVisit,
  rescheduledConfirmation,
  rescheduleEmailOutcome,
  rescheduleEmailsVisitor,
  scheduleChanged,
  toCancelRequest,
  toVisitUpdate,
  validateCancel,
  validateVisitEdit,
  withEditedStart,
} from './visitEdit'

const visit = makeVisit() // 6 Oct 2026, 06:00–\u206007:00 UTC

function rescheduledWith(last_notice: Visit['last_notice']): Visit {
  return makeVisit({ scheduled_start: '2026-10-07T06:00:00Z', last_notice })
}

function cancelledWith(last_notice: Visit['last_notice']): Visit {
  return makeVisit({ status: 'CANCELLED', cancelled_at: '2026-10-05T06:12:00Z', last_notice })
}
const NOW = Date.parse('2026-10-05T06:10:00Z')

describe('visit edit', () => {
  it('sends nothing when nothing changed, including the same instant written differently', () => {
    const values = { ...editValuesFromVisit(visit), start: '2026-10-06T06:00:00.000Z' }
    expect(toVisitUpdate(values, visit)).toEqual({})
    expect(scheduleChanged(values, visit)).toBe(false)
  })

  it('sends only the changed fields; a cleared department is null', () => {
    const values = { ...editValuesFromVisit(visit), purpose: ' Contract signing ', departmentId: '' }
    expect(toVisitUpdate(values, visit)).toEqual({ purpose: 'Contract signing', department_id: null })
    expect(toVisitUpdate({ ...editValuesFromVisit(visit), departmentId: LEGAL.id }, visit)).toEqual({ department_id: LEGAL.id })
  })

  it('reschedules with both ends when the start moves (the length is kept)', () => {
    const values = withEditedStart(editValuesFromVisit(visit), '2026-10-07T07:00:00.000Z')
    expect(scheduleChanged(values, visit)).toBe(true)
    expect(toVisitUpdate(values, visit)).toEqual({
      scheduled_start: '2026-10-07T07:00:00.000Z',
      scheduled_end: '2026-10-07T08:00:00.000Z',
    })
  })

  it('checks "not in the past" only for a new start', () => {
    const started = makeVisit({ scheduled_start: '2026-10-05T06:00:00Z', scheduled_end: '2026-10-05T07:00:00Z' })
    expect(validateVisitEdit({ ...editValuesFromVisit(started), purpose: 'New purpose' }, started, NOW)).toEqual({})
    expect(
      validateVisitEdit({ ...editValuesFromVisit(started), start: '2026-10-05T05:00:00Z', end: '2026-10-05T07:00:00Z' }, started, NOW),
    ).toEqual({ start: SCHEDULE_MESSAGES.inPast })
  })

  it('refuses to move the end of a visit under way into the past, as the server does (B24-24)', () => {
    // Started at 09:00, now 09:10: the end may move, but not to 09:05.
    const started = makeVisit({ scheduled_start: '2026-10-05T06:00:00Z', scheduled_end: '2026-10-05T07:00:00Z' })
    expect(validateVisitEdit({ ...editValuesFromVisit(started), end: '2026-10-05T06:05:00Z' }, started, NOW)).toEqual({
      end: SCHEDULE_MESSAGES.endInPast,
    })
    expect(validateVisitEdit({ ...editValuesFromVisit(started), end: '2026-10-05T08:00:00Z' }, started, NOW)).toEqual({})
  })

  it('applies no schedule rule while the schedule is unchanged, as the server does', () => {
    // In its grace period after the end: still SCHEDULED, and its purpose can still change.
    const ended = makeVisit({ scheduled_start: '2026-10-05T05:00:00Z', scheduled_end: '2026-10-05T06:00:00Z' })
    expect(validateVisitEdit({ ...editValuesFromVisit(ended), purpose: 'Rescheduled online' }, ended, NOW)).toEqual({})
    expect(validateVisitEdit({ ...editValuesFromVisit(ended), end: null }, ended, NOW)).toEqual({ end: SCHEDULE_MESSAGES.endRequired })
  })

  it('requires a purpose and a valid range', () => {
    expect(validateVisitEdit({ ...editValuesFromVisit(visit), purpose: ' ', end: visit.scheduled_start }, visit, NOW)).toEqual({
      purpose: 'Enter the purpose of the visit.',
      end: SCHEDULE_MESSAGES.endBeforeStart,
    })
  })
})

describe('cancel request', () => {
  it('leaves out a blank reason and always states whether to notify the visitor', () => {
    expect(toCancelRequest({ reason: '  ', notifyVisitor: true })).toEqual({ notify_visitor: true })
    expect(toCancelRequest({ reason: ' Host is ill ', notifyVisitor: false })).toEqual({ reason: 'Host is ill', notify_visitor: false })
  })

  it('limits the reason to 300 characters', () => {
    expect(validateCancel({ reason: 'x'.repeat(300), notifyVisitor: true })).toEqual({})
    expect(validateCancel({ reason: 'x'.repeat(301), notifyVisitor: true })).toEqual({ reason: 'Enter at most 300 characters.' })
  })
})

describe('which emails a change sends', () => {
  const invited = makeVisit() // invitation SENT, visitor has an address (can_resend)
  const notInvited = makeVisit({ invitation: { status: 'NOT_SENT', to_email: null, attempts: 0, sent_at: null, last_attempt_at: null } })
  const noAddress = makeVisit({ permissions: { can_resend: false } })

  it('promises a reschedule email only when an invitation was requested and the visitor has an address (B24-25)', () => {
    expect(rescheduleEmailsVisitor(invited)).toBe(true)
    expect(rescheduleEmailsVisitor(makeVisit({ invitation: { status: 'FAILED' } }))).toBe(true)
    expect(rescheduleEmailsVisitor(notInvited)).toBe(false)
    expect(rescheduleEmailsVisitor(noAddress)).toBe(false)
  })

  it('confirms a reschedule email only when the response shows one queued, and says when the budget left it out', () => {
    const queued = { kind: 'VISIT_RESCHEDULED', status: 'PENDING', to_email: 'elodie@orbit.example', sent_at: null, error: null } as const
    const sent = { ...queued, status: 'SENT', sent_at: '2026-10-05T06:00:00Z' } as const

    expect(rescheduleEmailOutcome(invited, rescheduledWith(queued))).toBe('queued')
    expect(rescheduledConfirmation(invited, rescheduledWith(queued))).toEqual({
      tone: 'success',
      description: 'The visitor is being emailed the new date and time.',
    })
    // The earlier change's email is still the latest notice: this change was not emailed (B24-70 budget).
    const earlierSent = makeVisit({ last_notice: sent })
    expect(rescheduleEmailOutcome(earlierSent, rescheduledWith(sent))).toBe('omitted')
    expect(rescheduleEmailOutcome(invited, rescheduledWith(null))).toBe('omitted')
    expect(rescheduledConfirmation(invited, rescheduledWith(null))).toEqual({
      tone: 'warning',
      description: 'The visitor was not emailed: the limit for emails about changes was reached.',
    })
    // An earlier email still being sent cannot be told apart from a new one: the toast is its title
    // alone (pointing at the timeline was a note, decision 3).
    const earlierPending = makeVisit({ last_notice: queued })
    expect(rescheduleEmailOutcome(earlierPending, rescheduledWith(queued))).toBe('unknown')
    expect(rescheduledConfirmation(earlierPending, rescheduledWith(queued))).toEqual({ tone: 'success' })
    expect(rescheduleEmailOutcome(noAddress, rescheduledWith(null))).toBe('none-expected')
    expect(rescheduledConfirmation(notInvited, rescheduledWith(null))).toEqual({
      tone: 'success',
      description: 'The visitor was not emailed.',
    })
  })

  it('offers to email a cancellation only when an invitation was requested and the visitor has an address (B24-70)', () => {
    expect(cancelEmailsVisitor(invited)).toBe(true)
    expect(cancelEmailsVisitor(makeVisit({ invitation: { status: 'FAILED' } }))).toBe(true)
    expect(cancelEmailsVisitor(makeVisit({ invitation: { status: 'PENDING' } }))).toBe(true)
    // The visitor has an address, but the visit was created without an invitation: the server ignores notify_visitor.
    expect(cancelEmailsVisitor(notInvited)).toBe(false)
    expect(cancelEmailsVisitor(noAddress)).toBe(false)

    expect(cancelNoEmailNotice(invited)).toBeNull()
    expect(cancelNoEmailNotice(notInvited)).toBe('The visitor will not be emailed.')
    expect(cancelNoEmailNotice(noAddress)).toBe('The visitor will not be emailed.')
  })

  it('says a cancellation was emailed only when the response shows the cancellation email', () => {
    const notice = { kind: 'VISIT_CANCELLED', status: 'PENDING', to_email: 'elodie@orbit.example', sent_at: null, error: null } as const
    expect(cancelledMessage(cancelledWith(notice))).toBe('The visitor is being notified by email.')
    // Not asked to notify, no address, no invitation, or asked but no email was queued: never claimed.
    expect(cancelledMessage(cancelledWith(null))).toBe('The visitor was not notified.')
    const reschedule = { ...notice, kind: 'VISIT_RESCHEDULED', status: 'SENT', sent_at: '2026-10-05T06:00:00Z' } as const
    expect(cancelledMessage(cancelledWith(reschedule))).toBe('The visitor was not notified.')
  })
})

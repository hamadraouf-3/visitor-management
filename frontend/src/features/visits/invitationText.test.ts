import { describe, expect, it } from 'vitest'
import { makeVisit } from '../../test/fixtures'
import type { Visit } from '../../types/api'
import { i18n } from '../../i18n'
import {
  calendarInvitationFailed,
  cancellationNoticeText,
  invitationFailedTitle,
  invitationStatusText,
  invitationSummaryText,
  inviteSuccessTitle,
  passIsOnlyChannel,
  reusedVisitorMismatch,
} from './invitationText'

describe('a failed invitation', () => {
  it('is titled once, with the address it was not delivered to', () => {
    const failed = makeVisit({ invitation: { status: 'FAILED', sent_at: null } }).invitation
    expect(invitationFailedTitle(failed)).toEqual(['Invitation not delivered to ', { email: 'elodie@orbit.example' }])
    expect(invitationFailedTitle({ ...failed, to_email: null })).toEqual(['Invitation not delivered'])
  })
})

describe('an invitation whose calendar invitation did not arrive (calendar_failed)', () => {
  // The invitation, with the pass, went out; the calendar invitation that followed it failed.
  const calendarFailed = makeVisit({ invitation: { status: 'FAILED', sent_at: null, calendar_failed: true, error: 'Mailbox full' } })

  it('is told apart from a failed invitation, and only in the FAILED state', () => {
    expect(calendarInvitationFailed(calendarFailed.invitation)).toBe(true)
    expect(calendarInvitationFailed(makeVisit({ invitation: { status: 'FAILED', sent_at: null } }).invitation)).toBe(false)
    expect(calendarInvitationFailed(makeVisit({ invitation: { calendar_failed: true } }).invitation)).toBe(false)
  })

  it('is worded as the calendar invitation’s, in the title, the status line and the summary', () => {
    expect(invitationFailedTitle(calendarFailed.invitation)).toEqual(['The calendar invitation did not reach ', { email: 'elodie@orbit.example' }])
    expect(invitationFailedTitle({ ...calendarFailed.invitation, to_email: null })).toEqual(['Calendar invitation not delivered'])
    const sentence = ['The calendar invitation did not reach ', { email: 'elodie@orbit.example' }, '.']
    expect(invitationStatusText(calendarFailed.invitation, false)).toEqual(sentence)
    expect(invitationSummaryText(calendarFailed.invitation, 'Asia/Amman', false)).toEqual(sentence)
  })

  it('in Arabic too', async () => {
    await i18n.changeLanguage('ar')
    try {
      expect(invitationFailedTitle(calendarFailed.invitation)).toEqual(['لم تصل دعوة التقويم إلى ', { email: 'elodie@orbit.example' }])
      expect(invitationFailedTitle({ ...calendarFailed.invitation, to_email: null })).toEqual(['لم تصل دعوة التقويم'])
      expect(invitationStatusText(calendarFailed.invitation, false)).toEqual(['لم تصل دعوة التقويم إلى ', { email: 'elodie@orbit.example' }, '.'])
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  it('leaves the pass to the invitation e-mail: the link is not the only channel', () => {
    expect(passIsOnlyChannel(calendarFailed)).toBe(false)
  })
})

describe('the one-time pass link', () => {
  it('is the only channel when no invitation email carries the QR code (it is then the primary action)', () => {
    expect(passIsOnlyChannel(makeVisit({ invitation: { status: 'FAILED', sent_at: null } }))).toBe(true)
    expect(passIsOnlyChannel(makeVisit({ invitation: { status: 'NOT_SENT', to_email: null, attempts: 0, sent_at: null, last_attempt_at: null } }))).toBe(true)
    expect(passIsOnlyChannel(makeVisit())).toBe(false)
    expect(passIsOnlyChannel(makeVisit({ invitation: { status: 'PENDING', sent_at: null } }))).toBe(false)
  })
})

function reusedAs(name: string): Visit {
  return makeVisit({ visitor: { id: 'v9', full_name: name, company_name: null } })
}

function cancelledWith(last_notice: Visit['last_notice']): Visit {
  return makeVisit({ status: 'CANCELLED', cancelled_at: '2026-10-05T06:12:00Z', last_notice })
}

describe('the success view after an inline reuse', () => {
  const typed = { fullName: 'Karim Fail', email: 'visitor@fail.test' }

  it('warns when the existing visitor has another name than the one typed', () => {
    expect(reusedVisitorMismatch(typed, true, reusedAs('Sami Nasser'))).toEqual([
      'You entered “Karim Fail”, but ',
      { email: 'visitor@fail.test' },
      ' already belongs to “Sami Nasser”, so this visit is for “Sami Nasser”.',
    ])
  })

  it('stays quiet when the names are the same person’s, however written, or nothing was reused', () => {
    expect(reusedVisitorMismatch(typed, true, reusedAs('  karim   FAIL '))).toBeNull()
    expect(reusedVisitorMismatch({ fullName: 'Elodie Martin', email: 'e@x.test' }, true, reusedAs('Élodie Martin'))).toBeNull()
    expect(reusedVisitorMismatch(typed, false, reusedAs('Sami Nasser'))).toBeNull()
    // A returning visitor picked from the list: nothing was typed.
    expect(reusedVisitorMismatch(null, true, reusedAs('Sami Nasser'))).toBeNull()
  })

  it('titles the page with the outcome', () => {
    expect(inviteSuccessTitle(makeVisit())).toBe('Visit scheduled')
    expect(inviteSuccessTitle(makeVisit({ status: 'CANCELLED', cancelled_at: '2026-10-05T06:12:00Z' }))).toBe('Visit cancelled')
  })
})

describe('the cancelled visit’s line about the cancellation email', () => {
  const notice = { kind: 'VISIT_CANCELLED', to_email: 'elodie@orbit.example', error: null } as const

  it('says whether the visitor was told', () => {
    expect(cancellationNoticeText(cancelledWith({ ...notice, status: 'SENT', sent_at: '2026-10-05T06:12:03Z' }))).toEqual([
      'The cancellation was emailed to ',
      { email: 'elodie@orbit.example' },
      '.',
    ])
    expect(cancellationNoticeText(cancelledWith({ ...notice, status: 'PENDING', sent_at: null }))).toEqual([
      'The cancellation is being emailed to ',
      { email: 'elodie@orbit.example' },
      '.',
    ])
    expect(cancellationNoticeText(cancelledWith({ ...notice, status: 'FAILED', sent_at: null, error: 'Mailbox unavailable' }))).toEqual([
      'The cancellation email to ',
      { email: 'elodie@orbit.example' },
      ' could not be sent. Let the visitor know yourself.',
    ])
  })

  it('says when no cancellation email went out, also when the latest notice is an earlier reschedule email', () => {
    expect(cancellationNoticeText(cancelledWith(null))).toEqual(['The visitor was not emailed about the cancellation.'])
    const reschedule = { ...notice, kind: 'VISIT_RESCHEDULED', status: 'SENT', sent_at: '2026-10-05T06:00:00Z' } as const
    expect(cancellationNoticeText(cancelledWith(reschedule))).toEqual(['The visitor was not emailed about the cancellation.'])
  })
})

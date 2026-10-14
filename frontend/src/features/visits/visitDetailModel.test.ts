import { describe, expect, it } from 'vitest'
import { makeVisit } from '../../test/fixtures'
import {
  canIssuePassLink,
  hasFailedInvitation,
  invitationCardTitle,
  isFinishedVisit,
  isOriginalInvitation,
  visitHeaderActions,
  visitorHasNoEmailOnFile,
  wantsVisitorCorrection,
} from './visitDetailModel'

const NOT_SENT = { status: 'NOT_SENT', to_email: null, attempts: 0, sent_at: null, last_attempt_at: null } as const
const NO_PERMISSIONS = { can_edit: false, can_cancel: false, can_resend: false } as const

function actionIds(...args: Parameters<typeof visitHeaderActions>) {
  return visitHeaderActions(...args).map(({ id, label, tone }) => `${id}:${label}:${tone}`)
}

describe('visit page actions', () => {
  it('offers what the permissions allow, the destructive one marked', () => {
    expect(actionIds(makeVisit())).toEqual(['edit:Edit or reschedule:default', 'resend:Resend invitation:default', 'cancel:Cancel visit:danger'])
    expect(actionIds(makeVisit({ permissions: NO_PERMISSIONS }))).toEqual([])
    expect(actionIds(makeVisit({ permissions: { can_edit: false, can_resend: false, can_cancel: true } }))).toEqual(['cancel:Cancel visit:danger'])
  })

  it('leaves a failed invitation’s resend to the failure banner', () => {
    const failed = makeVisit({ invitation: { status: 'FAILED', sent_at: null } })
    expect(actionIds(failed)).toEqual(['edit:Edit or reschedule:default', 'cancel:Cancel visit:danger'])
    expect(hasFailedInvitation(failed)).toBe(true)
    // Once the visit is over, the failure no longer needs attention.
    expect(hasFailedInvitation({ ...failed, status: 'CANCELLED' })).toBe(false)
  })

  it('offers "Send invitation" when none was sent', () => {
    expect(actionIds(makeVisit({ invitation: NOT_SENT }))).toContain('resend:Send invitation:default')
  })
})

describe('a visitor without an email address', () => {
  const noAddress = makeVisit({ invitation: NOT_SENT, permissions: { can_resend: false } })

  it('is known only to callers who manage the visit', () => {
    expect(visitorHasNoEmailOnFile(noAddress)).toBe(true)
    expect(visitorHasNoEmailOnFile(makeVisit())).toBe(false)
    // can_resend is false for every caller who cannot manage the visit: no conclusion then.
    expect(visitorHasNoEmailOnFile(makeVisit({ permissions: NO_PERMISSIONS }))).toBe(false)
  })

  it('is offered an address correction, as is a failed invitation', () => {
    expect(wantsVisitorCorrection(noAddress)).toBe(true)
    expect(wantsVisitorCorrection(makeVisit({ invitation: { status: 'FAILED', sent_at: null } }))).toBe(true)
    expect(wantsVisitorCorrection(makeVisit())).toBe(false)
    // An address on file but no invitation requested: nothing to correct.
    expect(wantsVisitorCorrection(makeVisit({ invitation: NOT_SENT }))).toBe(false)
  })
})

describe('a new pass link (POST /visits/{id}/pass)', () => {
  it('is offered when no invitation email carries the pass, to callers who manage the visit', () => {
    // "I'll share the pass myself": nothing was emailed.
    expect(canIssuePassLink(makeVisit({ invitation: NOT_SENT }))).toBe(true)
    expect(canIssuePassLink(makeVisit({ invitation: NOT_SENT, permissions: { can_resend: false } }))).toBe(true)
    // The address was removed after the invitation went out (D-19 revoked the pass).
    expect(canIssuePassLink(makeVisit({ permissions: { can_resend: false } }))).toBe(true)
  })

  it('is not offered while the invitation email carries the pass, or to callers who cannot change the visit', () => {
    expect(canIssuePassLink(makeVisit())).toBe(false)
    expect(canIssuePassLink(makeVisit({ invitation: { status: 'FAILED', sent_at: null } }))).toBe(false)
    expect(canIssuePassLink(makeVisit({ invitation: NOT_SENT, permissions: NO_PERMISSIONS }))).toBe(false)
  })
})

describe('finished visits', () => {
  it('show the invitation as history once the visit did not take place', () => {
    expect(isFinishedVisit(makeVisit())).toBe(false)
    expect(isFinishedVisit(makeVisit({ status: 'CHECKED_IN' }))).toBe(false)
    for (const status of ['CHECKED_OUT', 'CANCELLED', 'NO_SHOW'] as const) expect(isFinishedVisit(makeVisit({ status }))).toBe(true)

    expect(invitationCardTitle(makeVisit())).toBe('Invitation')
    expect(invitationCardTitle(makeVisit({ status: 'CHECKED_OUT' }))).toBe('Invitation')
    expect(invitationCardTitle(makeVisit({ status: 'CANCELLED' }))).toBe('Original invitation')
    expect(isOriginalInvitation(makeVisit({ status: 'NO_SHOW' }))).toBe(true)
  })
})

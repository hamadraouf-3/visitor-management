import { Ban, ExternalLink, Pencil, Send, UserPlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { Avatar } from '../../components/ui/Avatar'
import { Button, ButtonLink } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { TextWithEmails } from '../../components/ui/EmailText'
import { PageHeader } from '../../components/ui/PageHeader'
import { StatusBadge } from '../../components/ui/StatusBadge'
import { backLinkState } from '../../hooks/useBackLink'
import { useNow } from '../../hooks/useNow'
import { useDepartmentName } from '../../i18n/departmentName'
import { useCompanyName } from '../../i18n/useLanguage'
import { paths } from '../../paths'
import type { Me, VisitCreateResult } from '../../types/api'
import { focusPageHeading, isFocusLost } from '../../utils/focus'
import { textWithParts } from '../../utils/text'
import { EditVisitorDialog } from '../visitors/EditVisitorDialog'
import { AddToCalendar } from './AddToCalendar'
import { CancelVisitDialog } from './CancelVisitDialog'
import { FactList } from './FactList'
import { formatVisitDateRange } from './format'
import { offersHostCalendar } from './hostCalendar'
import { InvitationStatusLine } from './InvitationStatusLine'
import {
  calendarInvitationFailed,
  invitationFailedTitle,
  inviteSuccessTitle,
  passIsOnlyChannel,
  reusedVisitorMismatch,
  type TypedVisitor,
} from './invitationText'
import { PassActions } from './PassActions'
import { ResendInvitationDialog } from './ResendInvitationDialog'
import { useCorrectableVisitor } from './useCorrectableVisitor'
import { useVisitDetail } from './useVisitDetail'

export interface InviteSuccessProps {
  result: VisitCreateResult
  /** The new visitor as typed, or null for a returning visitor picked by id. */
  typedVisitor: TypedVisitor | null
  me: Me
  onInviteAnother: () => void
}

/** What replaced the pass link shown first. */
type PassChange = { kind: 'resent' } | { kind: 'email-changed'; email: string } | { kind: 'email-cleared' }

/**
 * After "Invite visitor": the outcome as the page title (the visit exists and its pass works),
 * the visit as a card (the visitor, the invitation's delivery status, polled while PENDING, §10,
 * when, host and department), a warning when an existing visitor record with another name was
 * used, the way out of a failed delivery, and the one-time pass as direction C's pass card.
 *
 * Recovering here changes the pass: a resend returns a new one-time link (shown instead of
 * the old one), and a corrected address makes the server issue a new pass and email it to
 * the new address (D-19), so the old link is withdrawn from the screen. Cancelling the visit
 * (offered with the name warning) withdraws it too.
 */
export function InviteSuccess({ result, typedVisitor, me, onInviteAnother }: InviteSuccessProps) {
  const { t } = useTranslation('visits')
  const timeZone = me.company.timezone
  const companyName = useCompanyName(me.company)
  const departmentName = useDepartmentName()
  const { query, pollingStopped, restartPolling } = useVisitDetail(result.visit.id)
  const visit = query.data ?? result.visit
  const { invitation } = visit
  const [passUrl, setPassUrl] = useState<string | null>(result.pass_url)
  const [passChange, setPassChange] = useState<PassChange | null>(null)
  const [dialog, setDialog] = useState<'resend' | 'correct-email' | 'cancel' | null>(null)
  const now = useNow()

  const cancelled = visit.status === 'CANCELLED'
  const failed = invitation.status === 'FAILED' && !cancelled
  const mismatch = cancelled ? null : reusedVisitorMismatch(typedVisitor, result.visitor_match.reused, visit)
  // Not after an inline reuse (D-05, B24-15): the address is the one the match was made on,
  // and the existing record must not be loaded into a form on the spot (§7.5 "reveals nothing").
  // Nor when only the calendar invitation failed: the invitation reached that address.
  const correctable = useCorrectableVisitor(visit, failed && !calendarInvitationFailed(invitation) && !result.visitor_match.reused)

  // The form this view replaces had focus; continue from the outcome (the page title). After a
  // cancellation from here, the button that opened the dialog is gone: continue there again.
  useEffect(() => {
    if (!cancelled || isFocusLost()) focusPageHeading()
  }, [cancelled])
  // The failure's alert goes once the failure is over (a resend, a correction): its focus, if it had
  // it, goes on from the page's title.
  const failedBefore = useRef(failed)
  useEffect(() => {
    if (failedBefore.current && !failed && isFocusLost()) focusPageHeading()
    failedBefore.current = failed
  }, [failed])

  const checkAgain = () => {
    restartPolling()
    void query.refetch()
  }
  const openCorrection = correctable ? () => setDialog('correct-email') : undefined
  const canResend = visit.permissions.can_resend
  const shownPassUrl = cancelled ? null : passUrl
  // One primary action: the visit once the email carries the pass, otherwise "Copy link" (PassActions).
  const emailCarriesPass = shownPassUrl === null || !passIsOnlyChannel(visit)

  return (
    <>
      <PageHeader title={inviteSuccessTitle(visit)} back={{ to: paths.myVisits, label: t('backToMyVisits') }} />
      <div className="flex flex-col gap-5">
        {/* Who the visit is for comes before how it is delivered. */}
        {mismatch && (
          <Alert
            tone="warning"
            role="none"
            title={t('inviteSuccess.mismatchTitle')}
            action={
              visit.permissions.can_cancel && (
                <Button variant="secondary" icon={<Ban aria-hidden="true" />} onClick={() => setDialog('cancel')}>
                  {t('inviteSuccess.cancelThisVisit')}
                </Button>
              )
            }
          >
            <TextWithEmails parts={mismatch} />
          </Alert>
        )}

        {/* One alert for the failure and its ways out. While the pass link is on screen, "Copy link"
            on the pass card stays the primary action. */}
        {failed && (
          <Alert
            tone="danger"
            role="none"
            title={<TextWithEmails parts={invitationFailedTitle(invitation)} />}
            action={
              (openCorrection || canResend) && (
                <div className="flex flex-col gap-2 sm:flex-row">
                  {openCorrection && (
                    <Button variant="secondary" icon={<Pencil aria-hidden="true" />} onClick={openCorrection}>
                      {t('failure.correctAndResend')}
                    </Button>
                  )}
                  {canResend && (
                    <Button variant="secondary" icon={<Send aria-hidden="true" />} onClick={() => setDialog('resend')}>
                      {calendarInvitationFailed(invitation) ? t('failure.resendCalendar') : openCorrection ? t('failure.resendSame') : t('failure.resend')}
                    </Button>
                  )}
                </div>
              )
            }
          />
        )}

        {passChange && !cancelled && (
          <Alert tone="info" role="status" title={t('inviteSuccess.passReplacedTitle')}>
            {passChange.kind === 'email-changed' ? (
              <TextWithEmails
                parts={textWithParts((markers) => t('inviteSuccess.passReplacedEmailChanged', markers), { email: { email: passChange.email } })}
              />
            ) : (
              t('inviteSuccess.passReplacedPrevious')
            )}
          </Alert>
        )}

        <Card>
          <div className="flex flex-col gap-5">
            <div className="flex items-start gap-3.5">
              <Avatar name={visit.visitor.full_name} size="lg" tone={cancelled ? 'neutral' : 'highlight'} />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                  <div className="min-w-0">
                    <h2 className="text-section font-bold break-words text-fg">{visit.visitor.full_name}</h2>
                    {visit.visitor.company_name && <p className="text-sm break-words text-fg-muted">{visit.visitor.company_name}</p>}
                  </div>
                  <StatusBadge type="visit" status={visit.status} />
                </div>
                {/* One polite live region announces every change of the invitation's state, so it
                    stays mounted; after a failure the alert above shows the state, and the line
                    is only announced, not shown twice. */}
                {!cancelled && (
                  <InvitationStatusLine
                    invitation={invitation}
                    pollingStopped={pollingStopped}
                    onCheckAgain={checkAgain}
                    className={failed ? 'sr-only' : undefined}
                  />
                )}
              </div>
            </div>
            <FactList
              columns={3}
              className="border-t border-border-subtle pt-5"
              items={[
                {
                  term: t('detail.facts.when'),
                  description: (
                    <span className="font-numeric tabular-nums">{formatVisitDateRange(visit.scheduled_start, visit.scheduled_end, timeZone)}</span>
                  ),
                },
                { term: t('detail.facts.host'), description: visit.host.full_name },
                { term: t('detail.facts.department'), description: departmentName(visit.department) || '—' },
              ]}
            />
          </div>
        </Card>

        {shownPassUrl && <PassActions passUrl={shownPassUrl} visit={visit} companyName={companyName} timeZone={timeZone} />}

        {/* Three buttons whose words never wrap: at a large text size they are wider than a small
            tablet's row, and go on to a second one instead of past the screen's edge. */}
        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-row sm:flex-wrap">
          <ButtonLink
            to={paths.visit(visit.id)}
            state={backLinkState({ to: paths.myVisits, label: t('backToMyVisits'), owner: me.user.id })}
            variant={emailCarriesPass && !cancelled ? 'primary' : 'secondary'}
            icon={<ExternalLink aria-hidden="true" />}
          >
            {t('inviteSuccess.viewVisit')}
          </ButtonLink>
          {offersHostCalendar(visit, me.user.id, now) && <AddToCalendar visit={visit} me={me} />}
          <Button variant={cancelled ? 'primary' : 'secondary'} icon={<UserPlus aria-hidden="true" />} onClick={onInviteAnother}>
            {t('inviteSuccess.inviteAnother')}
          </Button>
        </div>
      </div>

      {dialog === 'resend' && (
        <ResendInvitationDialog
          visit={visit}
          onClose={() => setDialog(null)}
          onCorrectEmail={openCorrection}
          onResent={(resent) => {
            setDialog(null)
            // Only the calendar invitation went again (`pass_url` null): the pass on screen stays the one.
            if (resent.pass_url) {
              setPassUrl(resent.pass_url)
              setPassChange({ kind: 'resent' })
            }
            restartPolling()
          }}
        />
      )}
      {dialog === 'correct-email' && correctable && (
        <EditVisitorDialog
          visitor={correctable}
          intent="correct-email"
          onClose={() => setDialog(null)}
          onSaved={(updated, body) => {
            if (!('email' in body)) return
            // D-19 revoked the pass this screen shows and issued a new one by email (or, for a
            // cleared address, none): the old link must not be shared any more.
            setPassUrl(null)
            setPassChange(updated.email ? { kind: 'email-changed', email: updated.email } : { kind: 'email-cleared' })
            restartPolling()
          }}
        />
      )}
      {dialog === 'cancel' && (
        <CancelVisitDialog
          visit={visit}
          timeZone={timeZone}
          onClose={() => setDialog(null)}
          onCancelled={() => {
            // The pass was revoked with the visit: its one-time link must not be shared.
            setPassUrl(null)
            restartPolling()
          }}
        />
      )}
    </>
  )
}

import { Ban, Building2, CalendarPlus, Ellipsis, FileQuestion, Pencil, Send, ShieldX, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isApiError } from '../../api/client'
import { hasAnyRole, SECTION_ACCESS } from '../../auth/roles'
import { Alert } from '../../components/ui/Alert'
import { ApiErrorMessage } from '../../components/ui/ApiErrorMessage'
import { Badge } from '../../components/ui/Badge'
import { Button, ButtonLink } from '../../components/ui/Button'
import { buttonClassName } from '../../components/ui/buttonStyles'
import { TextWithEmails } from '../../components/ui/EmailText'
import { EmptyState } from '../../components/ui/EmptyState'
import { Menu } from '../../components/ui/Menu'
import { PageHeader } from '../../components/ui/PageHeader'
import { PageSpinner } from '../../components/ui/Spinner'
import { StatusBadge } from '../../components/ui/StatusBadge'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { useBackLink, type BackLink } from '../../hooks/useBackLink'
import { useStableId } from '../../hooks/useStableId'
import { useCompanyName } from '../../i18n/useLanguage'
import { paths } from '../../paths'
import type { Me, Visit } from '../../types/api'
import { formatDateAtTime } from '../../utils/datetime'
import { focusPageHeading, isFocusLost } from '../../utils/focus'
import { EditVisitorDialog } from '../visitors/EditVisitorDialog'
import { CancelVisitDialog } from './CancelVisitDialog'
import { EditVisitDialog } from './EditVisitDialog'
import { InvitationStatusLine } from './InvitationStatusLine'
import { cancellationNoticeText, invitationFailedTitle } from './invitationText'
import { IssuePassDialog } from './IssuePassDialog'
import { PassActions } from './PassActions'
import { ResendInvitationDialog } from './ResendInvitationDialog'
import { useCorrectableVisitor } from './useCorrectableVisitor'
import { useVisitDetail } from './useVisitDetail'
import { InvitationCard, PassCard, VisitFactsCard, VisitTimelineCard } from './VisitCards'
import {
  canIssuePassLink,
  hasFailedInvitation,
  visitHeaderActions,
  visitorHasNoEmailOnFile,
  wantsVisitorCorrection,
  type VisitActionId,
} from './visitDetailModel'

type VisitDialog = 'edit' | 'cancel' | 'resend' | 'issue-pass' | 'edit-visitor'

const ACTION_ICONS: Record<VisitActionId, LucideIcon> = { edit: Pencil, resend: Send, cancel: Ban }

/** Load failures: 404 and 403 get their own page; anything else can be retried. */
function VisitLoadError({ error, back, onRetry }: { error: unknown; back: BackLink; onRetry: () => void }) {
  const { t } = useTranslation('visits')
  const status = isApiError(error) ? error.status : 0
  const backAction = (
    <ButtonLink to={back.to} state={back.state} variant="secondary">
      {back.label}
    </ButtonLink>
  )
  if (status === 404) {
    return (
      <>
        <PageHeader title={t('detail.notFound.title')} back={back} />
        <EmptyState icon={FileQuestion} title={t('detail.notFound.heading')} action={backAction} />
      </>
    )
  }
  if (status === 403) {
    return (
      <>
        <PageHeader title={t('detail.noAccess.title')} back={back} />
        <EmptyState icon={ShieldX} title={t('detail.noAccess.heading')} description={<ApiErrorMessage error={error} />} action={backAction} />
      </>
    )
  }
  return (
    <>
      <PageHeader title={t('detail.title')} back={back} />
      <LoadErrorAlert title={t('detail.loadError')} error={error} onRetry={onRetry} />
    </>
  )
}

/**
 * A back link to the profile of the visit's visitor names them: the name comes from the visit
 * this user just loaded, not from the history entry (which keeps only generic words).
 */
function visitBackLink(back: BackLink, visit: Visit, backToVisitor: string): BackLink {
  const pathname = back.to.split(/[?#]/, 1)[0]
  return pathname === paths.visitor(visit.visitor.id) ? { ...back, label: backToVisitor } : back
}

/** A one-time pass link the host just got: from a resent invitation (with its delivery status) or an issued pass link. */
interface NewPass {
  passUrl: string
  /** The invitation email carries the pass too (resend); otherwise only this link does. */
  emailed: boolean
}

/** The one-time pass of a resent invitation or a newly issued pass link, until the host dismisses it. */
function NewPassPanel({
  pass,
  visit,
  me,
  pollingStopped,
  onCheckAgain,
  onDone,
}: {
  pass: NewPass
  visit: Visit
  me: Me
  pollingStopped: boolean
  onCheckAgain: () => void
  onDone: () => void
}) {
  const { t } = useTranslation(['visits', 'common'])
  const headingRef = useRef<HTMLHeadingElement>(null)
  const headingId = useStableId('new-pass')
  const companyName = useCompanyName(me.company)
  // The confirmation dialog just closed; lead the user to the one-time link instead of the
  // button that opened the dialog.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <section aria-labelledby={headingId} className="mb-6 flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 ref={headingRef} id={headingId} tabIndex={-1} className="text-section font-bold text-fg focus:outline-none">
            {t('detail.newPass.title')}
          </h2>
          {pass.emailed && <InvitationStatusLine invitation={visit.invitation} pollingStopped={pollingStopped} onCheckAgain={onCheckAgain} />}
          <p className="text-sm text-fg-secondary">{t('detail.newPass.previousStopped')}</p>
        </div>
        <Button variant="secondary" onClick={onDone} className="shrink-0">
          {t('detail.newPass.done')}
        </Button>
      </div>
      <PassActions passUrl={pass.passUrl} visit={visit} companyName={companyName} timeZone={me.company.timezone} />
    </section>
  )
}

/**
 * A failed invitation, right under the header: what happened and the ways out (no advice,
 * decision 3: the buttons say it). The likely fix is a corrected address (the server then
 * re-sends to it, D-19), so that is the primary action when the visitor may be edited;
 * resending to the same address is the secondary one.
 */
function InvitationFailedBanner({
  visit,
  onCorrectEmail,
  onResend,
}: {
  visit: Visit
  onCorrectEmail?: () => void
  onResend?: () => void
}) {
  const { t } = useTranslation('visits')
  return (
    <Alert
      tone="danger"
      role="none"
      className="mb-6"
      title={<TextWithEmails parts={invitationFailedTitle(visit.invitation)} />}
      action={
        (onCorrectEmail || onResend) && (
          <div className="flex flex-col gap-2 sm:flex-row">
            {onCorrectEmail && (
              <Button icon={<Pencil aria-hidden="true" />} onClick={onCorrectEmail}>
                {t('failure.correctAndResend')}
              </Button>
            )}
            {onResend && (
              <Button variant={onCorrectEmail ? 'secondary' : 'primary'} icon={<Send aria-hidden="true" />} onClick={onResend}>
                {onCorrectEmail ? t('failure.resendSame') : t('failure.resend')}
              </Button>
            )}
          </div>
        )
      }
    />
  )
}

/**
 * A cancelled or no-show visit: who and why in one place, under the header, whether the
 * visitor was told (the cancellation email, `last_notice`), and the host's likely next step
 * ("Invite again") for callers who may invite. A no-show is worded from the pass window: the
 * server marks it lazily (§5), so `no_show_at` is when the system noticed, which the timeline
 * shows, not when the pass expired.
 */
function VisitOutcomeBanner({ visit, timeZone, canInvite }: { visit: Visit; timeZone: string; canInvite: boolean }) {
  const { t } = useTranslation('visits')
  const inviteAgain = canInvite && (
    <ButtonLink to={paths.inviteVisitorAgain(visit.visitor.id)} variant="secondary" icon={<CalendarPlus aria-hidden="true" />}>
      {t('detail.outcome.inviteAgain')}
    </ButtonLink>
  )
  if (visit.status === 'CANCELLED' && visit.cancelled_at) {
    const when = formatDateAtTime(visit.cancelled_at, timeZone)
    const noticeFailed = visit.last_notice?.kind === 'VISIT_CANCELLED' && visit.last_notice.status === 'FAILED'
    return (
      <Alert tone="danger" role="none" className="mb-6" title={t('detail.outcome.cancelledTitle')} action={inviteAgain}>
        <span className="block">
          {visit.cancelled_by
            ? t('detail.outcome.cancelledByOn', { name: visit.cancelled_by.full_name, when })
            : t('detail.outcome.cancelledOn', { when })}{' '}
          {visit.cancellation_reason ? t('detail.outcome.reason', { reason: visit.cancellation_reason }) : t('detail.outcome.noReason')}
        </span>
        <span className={noticeFailed ? 'mt-1 block font-medium' : 'mt-1 block'}>
          <TextWithEmails parts={cancellationNoticeText(visit)} />
        </span>
      </Alert>
    )
  }
  if (visit.status === 'NO_SHOW') {
    return (
      <Alert tone="warning" role="none" className="mb-6" title={t('detail.outcome.noShowTitle')} action={inviteAgain}>
        {t('detail.outcome.passExpiredOn', { when: formatDateAtTime(visit.window_end, timeZone) })}
      </Alert>
    )
  }
  return null
}

export interface VisitDetailProps {
  visitId: string
  me: Me
}

/**
 * A visit (§10 /visits/:id): header with the visitor and status, a banner when the invitation
 * failed or the visit ended without taking place, then one fixed order of cards: details,
 * invitation, visitor pass, timeline (on wide screens the invitation and the pass form the side
 * column). The invitation and any notice are polled while being sent. What is offered comes
 * from `visitDetailModel` (the visit's `permissions`; the page never infers rights from roles).
 */
export function VisitDetail({ visitId, me }: VisitDetailProps) {
  const { t } = useTranslation(['visits', 'common'])
  const timeZone = me.company.timezone
  const hasMyVisits = hasAnyRole(me.user.roles, SECTION_ACCESS.myVisits)
  const canInvite = hasAnyRole(me.user.roles, SECTION_ACCESS.inviteVisitor)
  const back = useBackLink(hasMyVisits ? { to: paths.myVisits, label: t('backToMyVisits') } : { to: paths.visitors, label: t('backToVisitors') })
  const { query, pollingStopped, restartPolling } = useVisitDetail(visitId)
  const [dialog, setDialog] = useState<VisitDialog | null>(null)
  const [newPass, setNewPass] = useState<NewPass | null>(null)
  const visit = query.data

  // A dialog returns focus to the button that opened it; after a cancellation that button is
  // gone (the visit no longer allows it), so continue from the page heading instead.
  const dialogWasOpen = useRef(false)
  useEffect(() => {
    if (dialog) {
      dialogWasOpen.current = true
      return
    }
    if (dialogWasOpen.current && isFocusLost()) focusPageHeading()
    dialogWasOpen.current = false
  }, [dialog])

  const correctable = useCorrectableVisitor(visit, visit !== undefined && wantsVisitorCorrection(visit))

  const checkAgain = () => {
    restartPolling()
    void query.refetch()
  }

  if (!visit) {
    if (query.isError) {
      return (
        <VisitLoadError error={query.error} back={back} onRetry={() => void query.refetch()} />
      )
    }
    return (
      <>
        <PageHeader title={t('detail.title')} back={back} />
        <PageSpinner label={t('detail.loading')} />
      </>
    )
  }

  const closeDialog = () => setDialog(null)
  const openCorrection = correctable ? () => setDialog('edit-visitor') : undefined
  const actions = visitHeaderActions(visit).map((action) => ({
    ...action,
    icon: ACTION_ICONS[action.id],
    onSelect: () => setDialog(action.id),
  }))

  return (
    <>
      <PageHeader
        title={visit.visitor.full_name}
        // Never the visitor's name: the browser keeps page titles in its saved history (§7.2 shared devices).
        documentTitle={t('detail.title')}
        back={visitBackLink(back, visit, t('backToName', { name: visit.visitor.full_name }))}
        meta={
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-fg-secondary">
            <span className="flex flex-wrap items-center gap-2">
              <StatusBadge type="visit" status={visit.status} />
              {visit.status === 'SCHEDULED' && <StatusBadge type="invitation" status={visit.invitation.status} standalone />}
              {visit.is_walk_in && <Badge tone="accent">{t('walkInBadge')}</Badge>}
            </span>
            {visit.visitor.company_name && (
              <span className="flex min-w-0 items-center gap-1.5">
                <Building2 aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
                <span className="min-w-0 break-words">{visit.visitor.company_name}</span>
              </span>
            )}
          </div>
        }
        actions={
          actions.length > 0 &&
          actions.map(({ id, label, icon: Icon, tone, onSelect }) => (
            <Button key={id} variant={tone === 'danger' ? 'danger-outline' : 'secondary'} icon={<Icon aria-hidden="true" />} onClick={onSelect}>
              {label}
            </Button>
          ))
        }
        // Phones: one compact menu beside the title, so the content (and a failure banner with
        // its own recovery actions) comes first, and "Cancel visit" is not a prominent button.
        mobileActions={
          actions.length > 0 && (
            <Menu
              trigger={
                <>
                  <Ellipsis aria-hidden="true" />
                  {t('detail.actions.menu')}
                </>
              }
              triggerClassName={buttonClassName({ variant: 'secondary' })}
              items={actions}
            />
          )
        }
      />

      {hasFailedInvitation(visit) && (
        <InvitationFailedBanner
          visit={visit}
          onCorrectEmail={openCorrection}
          onResend={visit.permissions.can_resend ? () => setDialog('resend') : undefined}
        />
      )}
      <VisitOutcomeBanner visit={visit} timeZone={timeZone} canInvite={canInvite} />

      {newPass && (
        <NewPassPanel
          pass={newPass}
          visit={visit}
          me={me}
          pollingStopped={pollingStopped}
          onCheckAgain={checkAgain}
          onDone={() => {
            // The panel (and the focused Done button) goes away with the one-time link.
            focusPageHeading()
            setNewPass(null)
          }}
        />
      )}

      {/* One order everywhere: details, invitation, pass, timeline. On wide screens the
          invitation and the pass are the side column next to details and timeline; in one
          column the two status cards a host checks first come before the long timeline. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:grid-rows-[auto_1fr]">
        <div className="min-w-0 lg:col-span-2">
          <VisitFactsCard visit={visit} timeZone={timeZone} />
        </div>
        <div className="flex min-w-0 flex-col gap-6 lg:col-start-3 lg:row-span-2 lg:row-start-1">
          <InvitationCard
            visit={visit}
            timeZone={timeZone}
            pollingStopped={pollingStopped}
            onCheckAgain={checkAgain}
            visitorHasNoEmail={visitorHasNoEmailOnFile(visit)}
            onAddEmail={openCorrection}
            announce={newPass === null || !newPass.emailed}
          />
          <PassCard visit={visit} timeZone={timeZone} onIssuePass={canIssuePassLink(visit) ? () => setDialog('issue-pass') : undefined} />
        </div>
        <div className="min-w-0 lg:col-span-2 lg:row-start-2">
          <VisitTimelineCard visit={visit} timeZone={timeZone} />
        </div>
      </div>

      {dialog === 'edit' && <EditVisitDialog visit={visit} timeZone={timeZone} onClose={closeDialog} onSaved={restartPolling} />}
      {dialog === 'cancel' && <CancelVisitDialog visit={visit} timeZone={timeZone} onClose={closeDialog} onCancelled={restartPolling} />}
      {dialog === 'resend' && (
        <ResendInvitationDialog
          visit={visit}
          onClose={closeDialog}
          onCorrectEmail={openCorrection}
          onResent={(result) => {
            closeDialog()
            setNewPass({ passUrl: result.pass_url, emailed: true })
            restartPolling()
          }}
        />
      )}
      {dialog === 'issue-pass' && (
        <IssuePassDialog
          visit={visit}
          onClose={closeDialog}
          onIssued={(result) => {
            closeDialog()
            setNewPass({ passUrl: result.pass_url, emailed: false })
          }}
        />
      )}
      {dialog === 'edit-visitor' && correctable && (
        <EditVisitorDialog
          visitor={correctable}
          intent="correct-email"
          onClose={closeDialog}
          onSaved={(_updated, body) => {
            // A new address re-sends this visit's invitation (D-19): follow it until it is sent.
            // It also revoked any pass link on screen.
            if ('email' in body) {
              setNewPass(null)
              restartPolling()
            }
          }}
        />
      )}
    </>
  )
}

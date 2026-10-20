import { CalendarClock, Link2, MailPlus } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { DataLine } from '../../components/ui/DataLine'
import { EmailText } from '../../components/ui/EmailText'
import { IconTile } from '../../components/ui/IconTile'
import { PhoneLink } from '../../components/ui/PhoneLink'
import { StatusBadge } from '../../components/ui/StatusBadge'
import { useDepartmentName } from '../../i18n/departmentName'
import { paths } from '../../paths'
import type { Visit } from '../../types/api'
import { cn } from '../../utils/cn'
import { formatDateAtTime, formatDateTime } from '../../utils/datetime'
import { formatDuration } from '../../utils/duration'
import { DATA_SEPARATOR } from '../../utils/text'
import { FactList } from './FactList'
import { formatVisitDateRange } from './format'
import { InvitationStatusLine } from './InvitationStatusLine'
import { invitationSummaryText } from './invitationText'
import { PASS_REVOKE_REASON_LABELS } from './labels'
import { invitationCardTitle, isOriginalInvitation } from './visitDetailModel'
import { buildVisitTimeline, type TimelineTone } from './visitTimeline'

interface VisitCardProps {
  visit: Visit
  timeZone: string
}

/**
 * Schedule, people and purpose of a visit: the schedule first, in direction C's numerals on a
 * sunken strip, then the facts. `scheduleAction` (the host's "Add to my calendar", Phase 14) ends the
 * strip, or on phones takes a row of its own under the time.
 */
export function VisitFactsCard({ visit, timeZone, scheduleAction }: VisitCardProps & { scheduleAction?: ReactNode }) {
  const { t } = useTranslation('visits')
  const departmentName = useDepartmentName()
  return (
    <Card title={t('detail.facts.title')}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3.5 rounded-control bg-surface-sunken px-4 py-3.5">
          <IconTile icon={CalendarClock} tone="accent" />
          <dl className="min-w-0 flex-1">
            <dt className="text-meta font-medium text-fg-muted">{t('detail.facts.when')}</dt>
            <dd className="mt-0.5 font-numeric text-lg leading-snug font-semibold break-words text-fg tabular-nums">
              {formatVisitDateRange(visit.scheduled_start, visit.scheduled_end, timeZone)}
            </dd>
          </dl>
          {scheduleAction && <div className="basis-full sm:basis-auto">{scheduleAction}</div>}
        </div>
        <FactList
          items={[
            {
              term: t('detail.facts.visitor'),
              description: (
                <>
                  {/* 44 px tall on touch screens: 12 px reach up over the term, the company moves 12 px down.
                      A name too long for the line still wraps (the flex item would not shrink below its longest word). */}
                  <Link
                    to={paths.visitor(visit.visitor.id)}
                    className="inline-flex items-center rounded-sm font-semibold wrap-anywhere text-accent-text hover:underline pointer-coarse:-mt-3 pointer-coarse:py-3"
                  >
                    {visit.visitor.full_name}
                  </Link>
                  {visit.visitor.company_name && <span className="block text-sm font-normal text-fg-muted">{visit.visitor.company_name}</span>}
                </>
              ),
            },
            {
              term: t('detail.facts.host'),
              description: (
                <>
                  <span className="block">{visit.host.full_name}</span>
                  {visit.host.phone && (
                    <span className="block text-sm font-normal">
                      <PhoneLink phone={visit.host.phone} label={t('call', { name: visit.host.full_name })} />
                    </span>
                  )}
                </>
              ),
            },
            { term: t('detail.facts.department'), description: departmentName(visit.department) || '—' },
            visit.duration_seconds !== null && {
              term: t('detail.facts.timeOnSite'),
              description: <span className="font-numeric tabular-nums">{formatDuration(visit.duration_seconds)}</span>,
            },
            {
              term: t('detail.facts.purpose'),
              description: <span className="font-normal whitespace-pre-wrap">{visit.purpose}</span>,
              wide: true,
            },
            {
              term: t('detail.facts.createdBy'),
              description: (
                <span className="font-normal">
                  {t('detail.facts.createdByOn', { name: visit.created_by.full_name, when: formatDateAtTime(visit.created_at, timeZone) })}
                </span>
              ),
              wide: true,
            },
          ]}
        />
      </div>
    </Card>
  )
}

const TONE_DOT: Record<TimelineTone, string> = {
  neutral: 'bg-neutral-solid',
  info: 'bg-info-solid',
  success: 'bg-success-solid',
  warning: 'bg-warning-solid',
  danger: 'bg-danger-solid',
}

/** What happened to the visit, oldest first (`buildVisitTimeline`). */
export function VisitTimelineCard({ visit, timeZone }: VisitCardProps) {
  const { t } = useTranslation('visits')
  const events = buildVisitTimeline(visit)
  return (
    <Card title={t('detail.timeline.title')}>
      <ol className="flex flex-col">
        {events.map((event, index) => (
          <li key={event.id} className="relative flex gap-3.5 pb-6 last:pb-0">
            {/* The connector runs through the dots' centre (12 px dots, a 2 px line 5 px in) on the
                inline start: left in English, right in Arabic, where the dots are. */}
            {index < events.length - 1 && (
              <span aria-hidden="true" data-timeline-connector="" className="absolute start-[5px] top-5 bottom-1 w-0.5 rounded-full bg-border" />
            )}
            <span aria-hidden="true" className={cn('relative mt-1.5 size-3 shrink-0 rounded-full ring-4 ring-surface', TONE_DOT[event.tone])} />
            <div className="min-w-0">
              <p className="text-[0.90625rem] leading-snug font-semibold text-fg">{event.title}</p>
              {event.at && (
                <p className="mt-0.5 text-meta text-fg-muted tabular-nums">
                  <time dateTime={event.at}>{formatDateTime(event.at, timeZone)}</time>
                </p>
              )}
              {/* Who an email went to, then what it means (e.g. "Let them know yourself"). */}
              {event.recipient && (
                <p className="text-meta text-fg-secondary">
                  <EmailText address={event.recipient} />
                </p>
              )}
              {/* Its facts each isolated (a name, a reason or a note in the other script keeps its place). */}
              {event.detail && (
                <p className="text-meta break-words text-fg-secondary">
                  <DataLine items={event.detail.split(DATA_SEPARATOR)} />
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  )
}

export interface InvitationCardProps extends VisitCardProps {
  /** Still PENDING after the polling window (§10). */
  pollingStopped: boolean
  onCheckAgain: () => void
  /** Known only to callers who manage the visit (`visitorHasEmail` in visitEdit). */
  visitorHasNoEmail: boolean
  /** Offered with `visitorHasNoEmail` when the caller may edit the visitor: opens their details. */
  onAddEmail?: () => void
  /** Announce status changes (off while another panel on the page announces them). */
  announce?: boolean
}

/**
 * The latest invitation email in one line ("Sent to … on …"), polled while PENDING, its state as
 * the chip in the card's header. Delivery attempts are shown only when they tell something (a
 * failure, or more than one attempt); the provider's sanitised error is a technical detail. Failure
 * recovery is the page banner's. For a visit that did not take place the card is history:
 * "Original invitation", its chip in a neutral tone.
 */
export function InvitationCard({
  visit,
  timeZone,
  pollingStopped,
  onCheckAgain,
  visitorHasNoEmail,
  onAddEmail,
  announce = true,
}: InvitationCardProps) {
  const { t } = useTranslation('visits')
  const { invitation } = visit
  const showAttempts = invitation.status === 'FAILED' || invitation.attempts > 1
  const lastAttemptAt = invitation.last_attempt_at
  return (
    <Card
      title={invitationCardTitle(visit)}
      actions={
        <StatusBadge
          type="invitation"
          status={invitation.status}
          calendarFailed={invitation.calendar_failed}
          tone={isOriginalInvitation(visit) ? 'neutral' : undefined}
        />
      }
    >
      <div className="flex flex-col gap-3">
        <InvitationStatusLine
          invitation={invitation}
          pollingStopped={pollingStopped}
          onCheckAgain={onCheckAgain}
          announce={announce}
          text={invitation.status === 'PENDING' ? undefined : invitationSummaryText(invitation, timeZone, visitorHasNoEmail)}
        />
        {invitation.status === 'NOT_SENT' && visitorHasNoEmail && onAddEmail && (
          <Button variant="secondary" icon={<MailPlus aria-hidden="true" />} onClick={onAddEmail} className="self-start">
            {t('detail.invitation.addEmail')}
          </Button>
        )}
        {showAttempts && (
          <p className="text-meta text-fg-muted">
            {lastAttemptAt
              ? t('detail.invitation.attemptsLast', { count: invitation.attempts, when: formatDateAtTime(lastAttemptAt, timeZone) })
              : t('detail.invitation.attempts', { count: invitation.attempts })}
          </p>
        )}
        {invitation.error && (
          <details className="text-meta text-fg-muted">
            <summary className="-my-2 cursor-pointer py-2 font-medium pointer-coarse:-my-3 pointer-coarse:py-3">{t('detail.invitation.technical')}</summary>
            <p className="mt-1 break-words">{invitation.error}</p>
          </details>
        )}
      </div>
    </Card>
  )
}

export interface PassCardProps extends VisitCardProps {
  /**
   * Offered when no invitation email carries the pass (`canIssuePassLink`): opens the
   * confirmation for a new one-time pass link, which replaces the current QR code.
   */
  onIssuePass?: () => void
}

/**
 * The visitor pass: active (with its validity), revoked (and why), expired, or none, its state as
 * the chip in the card's header. Its link is never shown again (§6); a host who shares the pass
 * themselves can issue a new link here.
 */
export function PassCard({ visit, timeZone, onIssuePass }: PassCardProps) {
  const { t } = useTranslation('visits')
  const { pass } = visit
  let sentence: string
  switch (pass.status) {
    case 'ACTIVE':
      sentence = t('detail.pass.active', { window: formatVisitDateRange(visit.window_start, visit.window_end, timeZone) })
      break
    case 'REVOKED':
      sentence = pass.revoke_reason ? PASS_REVOKE_REASON_LABELS[pass.revoke_reason] : t('detail.pass.revoked')
      break
    case 'EXPIRED':
      sentence = t('detail.pass.expired', { when: formatDateTime(visit.window_end, timeZone) })
      break
    case 'NONE':
      sentence = t('detail.pass.none')
      break
  }

  return (
    <Card title={t('detail.pass.title')} actions={<StatusBadge type="pass" status={pass.status} />}>
      <div className="flex flex-col gap-3">
        <div>
          <p className="text-sm font-medium text-fg">{sentence}</p>
          {pass.issued_at && <p className="mt-0.5 text-meta text-fg-muted">{t('detail.pass.issued', { when: formatDateTime(pass.issued_at, timeZone) })}</p>}
        </div>
        {onIssuePass && (
          <Button variant="secondary" icon={<Link2 aria-hidden="true" />} onClick={onIssuePass} className="self-start">
            {t('detail.pass.issueNew')}
          </Button>
        )}
      </div>
    </Card>
  )
}

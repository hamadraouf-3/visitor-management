import { i18n } from '../../i18n'
import type { Visit } from '../../types/api'
import { DATA_SEPARATOR } from '../../utils/text'
import { CHECK_IN_METHOD_LABELS, CHECK_OUT_METHOD_LABELS, walkInReasonLabel } from './labels'

const t = i18n.getFixedT(null, 'visits')

export type TimelineTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

export interface TimelineEvent {
  id: 'created' | 'invitation' | 'notice' | 'checked-in' | 'checked-out' | 'cancelled' | 'no-show'
  /** UTC ISO instant, or null when the visit does not record when it happened (see `noticeEvent`). */
  at: string | null
  title: string
  /** Second line (who, how, why). */
  detail: string | null
  /** An email address the event concerns (shown with break opportunities at its separators). */
  recipient?: string | null
  tone: TimelineTone
}

function joinDetail(...parts: (string | null | undefined)[]): string | null {
  // Rendered as a DataLine (each part isolated), split again at the separator.
  const text = parts.filter(Boolean).join(DATA_SEPARATOR)
  return text || null
}

type VisitNotice = NonNullable<Visit['last_notice']>

function noticeTitle(kind: VisitNotice['kind'], status: VisitNotice['status']): string {
  return t(`timeline.notice.${kind}.${status}`)
}

function noticeFailedDetail(kind: VisitNotice['kind']): string {
  return t(`timeline.noticeFailed.${kind}`)
}

/** Steps after which a visit no longer changes schedule: a reschedule notice always comes before them. */
const LEFT_SCHEDULED: ReadonlySet<TimelineEvent['id']> = new Set(['checked-in', 'checked-out', 'cancelled', 'no-show'])

/**
 * The latest cancellation or reschedule email (`Visit.last_notice`). It records when it was
 * sent, not when it was queued: an unsent cancellation notice was queued with the cancellation
 * (`cancelled_at`); an unsent reschedule notice has no time on the visit (`at` null).
 */
function noticeEvent(visit: Visit, notice: VisitNotice): TimelineEvent {
  const queuedAt = notice.kind === 'VISIT_CANCELLED' ? visit.cancelled_at : null
  return {
    id: 'notice',
    at: notice.status === 'SENT' ? notice.sent_at : queuedAt,
    title: noticeTitle(notice.kind, notice.status),
    detail: notice.status === 'FAILED' ? noticeFailedDetail(notice.kind) : null,
    recipient: notice.to_email,
    tone: notice.status === 'FAILED' ? 'danger' : 'info',
  }
}

/**
 * What happened to a visit, oldest first, from the facts on the visit itself: creation, the
 * latest invitation's outcome, the latest cancellation or reschedule email, check-in and
 * check-out (with method and note), cancellation (with reason) and no-show. Events without a
 * timestamp are left out, except an unsent reschedule email: it goes before the first step
 * after which the visit could no longer be rescheduled, or last.
 */
export function buildVisitTimeline(visit: Visit): TimelineEvent[] {
  const events: TimelineEvent[] = [
    {
      id: 'created',
      at: visit.created_at,
      title: visit.is_walk_in ? t('timeline.walkInRegistered') : t('timeline.created'),
      detail: joinDetail(
        t('timeline.by', { name: visit.created_by.full_name }),
        visit.is_walk_in && visit.walk_in_reason ? t('timeline.reason', { reason: walkInReasonLabel(visit.walk_in_reason) }) : null,
      ),
      tone: 'neutral',
    },
  ]

  const { invitation } = visit
  if (invitation.status === 'SENT' && invitation.sent_at) {
    events.push({
      id: 'invitation',
      at: invitation.sent_at,
      title: t('timeline.invitationSent'),
      detail: null,
      recipient: invitation.to_email,
      tone: 'info',
    })
  } else if (invitation.status === 'FAILED' && invitation.last_attempt_at) {
    events.push({
      id: 'invitation',
      at: invitation.last_attempt_at,
      // Only the calendar invitation that followed it failed: the invitation, with the pass, went out.
      title: invitation.calendar_failed ? t('timeline.calendarInvitationFailed') : t('timeline.invitationFailed'),
      detail: null,
      recipient: invitation.to_email,
      tone: 'danger',
    })
  }

  if (visit.check_in_at) {
    const method = visit.check_in_method ? CHECK_IN_METHOD_LABELS[visit.check_in_method] : null
    events.push({
      id: 'checked-in',
      at: visit.check_in_at,
      title: visit.checked_in_by ? t('timeline.checkedInBy', { name: visit.checked_in_by.full_name }) : t('timeline.checkedIn'),
      detail: joinDetail(method && t('timeline.method', { method }), visit.check_in_note && t('timeline.note', { note: visit.check_in_note })),
      tone: 'success',
    })
  }

  if (visit.check_out_at) {
    const method = visit.check_out_method ? CHECK_OUT_METHOD_LABELS[visit.check_out_method] : null
    events.push({
      id: 'checked-out',
      at: visit.check_out_at,
      title: visit.checked_out_by ? t('timeline.checkedOutBy', { name: visit.checked_out_by.full_name }) : t('timeline.checkedOut'),
      detail: joinDetail(method && t('timeline.method', { method }), visit.check_out_note && t('timeline.note', { note: visit.check_out_note })),
      tone: 'neutral',
    })
  }

  if (visit.cancelled_at) {
    events.push({
      id: 'cancelled',
      at: visit.cancelled_at,
      title: visit.cancelled_by ? t('timeline.cancelledBy', { name: visit.cancelled_by.full_name }) : t('timeline.cancelled'),
      detail: visit.cancellation_reason ? t('timeline.reason', { reason: visit.cancellation_reason }) : t('timeline.noReason'),
      tone: 'danger',
    })
  }

  if (visit.no_show_at) {
    events.push({
      id: 'no-show',
      at: visit.no_show_at,
      title: t('timeline.noShow'),
      detail: null,
      tone: 'warning',
    })
  }

  // Stable sort: events at the same instant keep their lifecycle order.
  const timeline = events.toSorted((a, b) => Date.parse(a.at ?? '') - Date.parse(b.at ?? ''))

  if (visit.last_notice) {
    const notice = noticeEvent(visit, visit.last_notice)
    const at = notice.at
    // Dated: after every event up to its instant, so after the cancellation it reports.
    // Undated (an unsent reschedule email): before the visit left SCHEDULED, or last.
    const index =
      at === null
        ? timeline.findIndex((event) => LEFT_SCHEDULED.has(event.id))
        : timeline.findIndex((event) => event.at !== null && Date.parse(event.at) > Date.parse(at))
    timeline.splice(index === -1 ? timeline.length : index, 0, notice)
  }
  return timeline
}

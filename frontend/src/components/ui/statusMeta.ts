import {
  Ban,
  CalendarClock,
  CalendarX2,
  CircleMinus,
  Clock,
  LogOut,
  MailCheck,
  MailMinus,
  MailX,
  ShieldCheck,
  ShieldOff,
  TimerOff,
  UserCheck,
  UserX,
  type LucideIcon,
} from 'lucide-react'
import { i18n } from '../../i18n'
import type { InvitationStatus, PassStatus, VisitStatus } from '../../types/api'
import type { Tone } from './tones'

export interface StatusMeta {
  /** The status in the UI language (read when rendered, so it follows a language switch). */
  label: string
  tone: Tone
  icon: LucideIcon
  /** The icon is directional (an arrow out of a door): mirrored in right-to-left text. */
  mirrorIcon?: boolean
}

/**
 * A status's label is a getter, so `META[status].label` is always in the current language, also
 * in code written before the UI had two languages (F10-7).
 */
function meta(label: () => string, tone: Tone, icon: LucideIcon, mirrorIcon = false): StatusMeta {
  return {
    get label() {
      return label()
    },
    tone,
    icon,
    mirrorIcon,
  }
}

/**
 * §10: Scheduled blue, Checked in green, Checked out grey, Cancelled red, No show amber (the chips
 * use `VISIT_STATUS_CHIP_CLASSES`, which also differ in lightness). The English label is spelled
 * "No-show", as in every other text (counts, reports, the Expected list).
 */
export const VISIT_STATUS_META: Record<VisitStatus, StatusMeta> = {
  SCHEDULED: meta(() => i18n.t('status.visit.SCHEDULED'), 'info', CalendarClock),
  CHECKED_IN: meta(() => i18n.t('status.visit.CHECKED_IN'), 'success', UserCheck),
  CHECKED_OUT: meta(() => i18n.t('status.visit.CHECKED_OUT'), 'neutral', LogOut, true),
  CANCELLED: meta(() => i18n.t('status.visit.CANCELLED'), 'danger', Ban),
  NO_SHOW: meta(() => i18n.t('status.visit.NO_SHOW'), 'warning', UserX),
}

/** Direction C's visit status chips (index.css `--color-status-*`). */
export const VISIT_STATUS_CHIP_CLASSES: Record<VisitStatus, string> = {
  SCHEDULED: 'border-status-scheduled-ring bg-status-scheduled-bg text-status-scheduled-fg',
  CHECKED_IN: 'border-status-in-ring bg-status-in-bg text-status-in-fg',
  CHECKED_OUT: 'border-status-out-ring bg-status-out-bg text-status-out-fg',
  CANCELLED: 'border-status-cancelled-ring bg-status-cancelled-bg text-status-cancelled-fg',
  NO_SHOW: 'border-status-noshow-ring bg-status-noshow-bg text-status-noshow-fg',
}

/**
 * Invitation vocabulary, one set of words everywhere:
 * - On its own (a page header, a list card, any place without an "Invitation" heading), the
 *   long form names the subject: {@link INVITATION_STATUS_LONG_LABELS} ("Invitation sent",
 *   "Invitation not sent", "Invitation failed", "Sending invitation"); StatusBadge `standalone`.
 * - The short form ("Sent", "Not sent", "Failed", "Sending") only under an "Invitation" column
 *   header or card title, which supplies the subject.
 */
export const INVITATION_STATUS_META: Record<InvitationStatus, StatusMeta> = {
  NOT_SENT: meta(() => i18n.t('status.invitation.NOT_SENT'), 'neutral', MailMinus),
  PENDING: meta(() => i18n.t('status.invitation.PENDING'), 'info', Clock),
  SENT: meta(() => i18n.t('status.invitation.SENT'), 'success', MailCheck),
  FAILED: meta(() => i18n.t('status.invitation.FAILED'), 'danger', MailX),
}

/** The invitation states where no "Invitation" heading names the subject (see INVITATION_STATUS_META). */
export const INVITATION_STATUS_LONG_LABELS: Readonly<Record<InvitationStatus, string>> = {
  get NOT_SENT() {
    return i18n.t('status.invitationLong.NOT_SENT')
  },
  get PENDING() {
    return i18n.t('status.invitationLong.PENDING')
  },
  get SENT() {
    return i18n.t('status.invitationLong.SENT')
  },
  get FAILED() {
    return i18n.t('status.invitationLong.FAILED')
  },
}

/**
 * An invitation FAILED only because the calendar invitation that followed it did not arrive
 * (`calendar_failed`, Phase 14): the invitation itself, and the pass in it, went out. Its own words
 * ("Calendar failed" under an "Invitation" heading, "Calendar invitation not delivered" on its own)
 * and a calendar's icon, so it never reads as a visitor without a pass.
 */
export function calendarInvitationFailedMeta(standalone: boolean): StatusMeta {
  return meta(() => i18n.t(standalone ? 'status.calendarInvitationFailed.long' : 'status.calendarInvitationFailed.short'), 'danger', CalendarX2)
}

export const PASS_STATUS_META: Record<PassStatus, StatusMeta> = {
  ACTIVE: meta(() => i18n.t('status.pass.ACTIVE'), 'success', ShieldCheck),
  REVOKED: meta(() => i18n.t('status.pass.REVOKED'), 'danger', ShieldOff),
  EXPIRED: meta(() => i18n.t('status.pass.EXPIRED'), 'warning', TimerOff),
  NONE: meta(() => i18n.t('status.pass.NONE'), 'neutral', CircleMinus),
}

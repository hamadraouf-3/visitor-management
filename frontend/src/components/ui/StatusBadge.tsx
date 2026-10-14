import { useTranslation } from 'react-i18next'
import type { InvitationStatus, PassStatus, VisitStatus } from '../../types/api'
import { Badge } from './Badge'
import {
  INVITATION_STATUS_LONG_LABELS,
  INVITATION_STATUS_META,
  PASS_STATUS_META,
  VISIT_STATUS_CHIP_CLASSES,
  VISIT_STATUS_META,
  type StatusMeta,
} from './statusMeta'
import type { Tone } from './tones'

interface CommonProps {
  /**
   * Overrides the status tone, e.g. `neutral` for a status that is history rather than the
   * current state (the original invitation of a cancelled visit). Icon and text still name it.
   */
  tone?: Tone
  /**
   * The chip's size. A visit's status is what its row or page is about: direction C's 28 px chip
   * (`md`) by default. Invitation and pass states are secondary facts: compact (`sm`) by default.
   */
  size?: 'sm' | 'md'
  className?: string
}

export type StatusBadgeProps =
  | ({ type: 'visit'; status: VisitStatus } & CommonProps)
  | ({
      type: 'invitation'
      status: InvitationStatus
      /**
       * No "Invitation" header or title names the subject here: show the long form
       * ("Invitation sent" instead of "Sent"), see INVITATION_STATUS_META.
       */
      standalone?: boolean
    } & CommonProps)
  | ({ type: 'pass'; status: PassStatus } & CommonProps)

function metaFor(props: StatusBadgeProps): StatusMeta {
  switch (props.type) {
    case 'visit':
      return VISIT_STATUS_META[props.status]
    case 'invitation': {
      const meta = INVITATION_STATUS_META[props.status]
      return props.standalone ? { ...meta, label: INVITATION_STATUS_LONG_LABELS[props.status] } : meta
    }
    case 'pass':
      return PASS_STATUS_META[props.status]
  }
}

/** Status shown as icon + text, never color alone (§10). Visit statuses use direction C's chips. */
export function StatusBadge(props: StatusBadgeProps) {
  // Re-renders on a language switch: the labels are read from the catalogs.
  useTranslation()
  const meta = metaFor(props)
  const chipClasses = props.type === 'visit' && !props.tone ? VISIT_STATUS_CHIP_CLASSES[props.status] : undefined
  return (
    <Badge
      tone={props.tone ?? meta.tone}
      colorClassName={chipClasses}
      icon={meta.icon}
      mirrorIcon={meta.mirrorIcon}
      size={props.size ?? (props.type === 'visit' ? 'md' : 'sm')}
      className={props.className}
    >
      {meta.label}
    </Badge>
  )
}

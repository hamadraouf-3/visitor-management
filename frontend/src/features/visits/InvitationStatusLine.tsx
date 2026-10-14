import { RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { TextWithEmails } from '../../components/ui/EmailText'
import { Spinner } from '../../components/ui/Spinner'
import type { Visit } from '../../types/api'
import { cn } from '../../utils/cn'
import type { TextPart } from '../../utils/text'
import { invitationStatusText } from './invitationText'

export interface InvitationStatusLineProps {
  invitation: Visit['invitation']
  /** Still PENDING after the polling window (§10): offer a manual check. */
  pollingStopped: boolean
  onCheckAgain: () => void
  /**
   * Announce changes (a polite live region, default). Off where another line on the page
   * already announces the same invitation, so it is not read out twice.
   */
  announce?: boolean
  /** The sentence to show instead of the default one (e.g. the visit page's summary); the spinner still shows while sending. */
  text?: readonly TextPart[]
  className?: string
}

/**
 * The invitation's state in one sentence, in a polite live region so each change (sending →
 * sent or failed) is announced: the region stays mounted while its text changes. While the
 * invitation is being sent a spinner shows the activity.
 */
export function InvitationStatusLine({
  invitation,
  pollingStopped,
  onCheckAgain,
  announce = true,
  text,
  className,
}: InvitationStatusLineProps) {
  const { t } = useTranslation('visits')
  const sending = invitation.status === 'PENDING' && !pollingStopped
  return (
    <div className={cn('flex flex-col items-start gap-2', className)}>
      <p
        role={announce ? 'status' : undefined}
        className={cn('flex items-start gap-2 text-sm', invitation.status === 'FAILED' ? 'font-medium text-danger-text' : 'text-fg')}
      >
        {sending && <Spinner size="sm" decorative className="mt-0.5" />}
        <span className="min-w-0">
          <TextWithEmails parts={text ?? invitationStatusText(invitation, pollingStopped)} />
        </span>
      </p>
      {pollingStopped && (
        <Button variant="secondary" size="sm" icon={<RotateCw aria-hidden="true" />} onClick={onCheckAgain}>
          {t('invitationText.checkAgain')}
        </Button>
      )}
    </div>
  )
}

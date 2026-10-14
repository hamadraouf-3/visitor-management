import { IdCard } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { ApiErrorMessage } from '../../components/ui/ApiErrorMessage'
import { Button } from '../../components/ui/Button'
import type { ButtonVariant } from '../../components/ui/buttonStyles'
import { Dialog } from '../../components/ui/Dialog'
import type { Visit } from '../../types/api'
import { VisitFacts } from './VisitFacts'

export interface ConfirmVisitDialogProps {
  visit: Visit
  timeZone: string
  now: number
  title: string
  description?: string
  /** Extra content above the visit's facts (e.g. a warning). */
  children?: ReactNode
  /** Shows the "Verify ID: <name>" cue (check-ins). */
  verifyId?: boolean
  confirmLabel: string
  confirmIcon?: ReactNode
  confirmVariant?: ButtonVariant
  /** The button focused when the dialog opens: the confirmation, or Cancel where a slip would be costly. */
  initialFocus?: 'confirm' | 'cancel'
  pending: boolean
  /** The failed confirmation; its server message is shown (§8.2). */
  error: unknown
  onConfirm: () => void
  onClose: () => void
}

/**
 * Confirms a check-in or check-out of one visit, with the facts that identify it. The name
 * is large, so it can be compared with the visitor's ID.
 */
export function ConfirmVisitDialog({
  visit,
  timeZone,
  now,
  title,
  description,
  children,
  verifyId = false,
  confirmLabel,
  confirmIcon,
  confirmVariant = 'primary',
  initialFocus = 'confirm',
  pending,
  error,
  onConfirm,
  onClose,
}: ConfirmVisitDialogProps) {
  const { t } = useTranslation('reception')
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      dismissible={!pending}
      initialFocusRef={initialFocus === 'confirm' ? confirmRef : cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" size="lg" onClick={onClose} disabled={pending} focusableWhenDisabled>
            {t('cancel')}
          </Button>
          <Button ref={confirmRef} variant={confirmVariant} size="lg" icon={confirmIcon} loading={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {Boolean(error) && (
          <Alert tone="danger">
            <ApiErrorMessage error={error} />
          </Alert>
        )}
        <div className="flex flex-col gap-3">
          <p className="text-2xl leading-tight font-bold break-words text-fg">{visit.visitor.full_name}</p>
          {verifyId && (
            <p className="flex items-center gap-2.5 rounded-control border-[1.5px] border-accent-strong bg-accent-surface px-3.5 py-2.5 font-semibold text-fg">
              <IdCard aria-hidden="true" className="size-5 shrink-0 text-accent-text" />
              {t('verifyId', { name: visit.visitor.full_name })}
            </p>
          )}
        </div>
        {children}
        <VisitFacts visit={visit} timeZone={timeZone} now={now} surface="raised" />
      </div>
    </Dialog>
  )
}

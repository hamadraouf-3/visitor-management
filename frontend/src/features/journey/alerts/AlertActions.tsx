import { CircleCheck, Eye } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../../components/ui/Alert'
import { ApiErrorMessage } from '../../../components/ui/ApiErrorMessage'
import { Button } from '../../../components/ui/Button'
import { Dialog } from '../../../components/ui/Dialog'
import { Field } from '../../../components/ui/Field'
import { Input } from '../../../components/ui/Input'
import { useToast } from '../../../components/ui/toastContext'
import { useStableId } from '../../../hooks/useStableId'
import type { TrackingAlert } from '../../../types/api'
import { focusPageHeading, isFocusLost } from '../../../utils/focus'
import { maxLengthMessage } from '../../../utils/forms'
import { characterCountLabel } from '../../../utils/text'
import { ALERT_NOTE_MAX } from './alertLabels'
import { useAlertAction, useRefreshAlerts, type AlertActionKind } from './queries'

/** An action asked for on an alert: which alert (as it was shown) and what. */
export interface AlertActing {
  alert: TrackingAlert
  kind: AlertActionKind
}

/**
 * Acknowledging or resolving, with an optional note of one line; the alert's visitor in the title. Rendered by
 * the list that shows the alert (the alerts page, a visit's journey, the live map's panel), never by the card:
 * the alert may leave the list while the dialog is open (resolved elsewhere, the 15 s refresh), and the dialog,
 * with a refusal it says, stays until the person closes it (F16-33). `onClose(acted)`: whether the alert changed
 * (done, or refused because it had changed): its list then looks after the focus (F16-34).
 */
export function AlertActionDialog({ alert, kind, onClose }: AlertActing & { onClose: (acted: boolean) => void }) {
  const { t } = useTranslation('journey')
  const toast = useToast()
  const action = useAlertAction()
  const refresh = useRefreshAlerts()
  const [note, setNote] = useState('')
  const [tooLong, setTooLong] = useState(false)
  const formId = useStableId('alert-action')
  const name = alert.visit.visitor.full_name

  const close = () => {
    // A refusal (409 ALERT_RESOLVED) was read here; what holds now is asked for once it is closed.
    if (action.isError) refresh()
    onClose(action.isError)
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (note.trim().length > ALERT_NOTE_MAX) {
      setTooLong(true)
      return
    }
    action.mutate(
      { alertId: alert.id, kind, note },
      {
        onSuccess: () => {
          toast.show({ tone: 'success', title: kind === 'acknowledge' ? t('alerts.acknowledgedToast') : t('alerts.resolvedToast') })
          onClose(true)
        },
      },
    )
  }

  return (
    <Dialog
      open
      onClose={close}
      dismissible={!action.isPending}
      title={kind === 'acknowledge' ? t('alerts.acknowledgeTitle', { name }) : t('alerts.resolveTitle', { name })}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={action.isPending} focusableWhenDisabled>
            {t('alerts.keep')}
          </Button>
          <Button type="submit" form={formId} loading={action.isPending}>
            {kind === 'acknowledge' ? t('alerts.acknowledge') : t('alerts.resolve')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        {action.isError && (
          <Alert tone="danger">
            <ApiErrorMessage error={action.error} outsideForm />
          </Alert>
        )}
        <Field label={t('alerts.note')} optional hint={characterCountLabel(note, ALERT_NOTE_MAX)} error={tooLong ? maxLengthMessage(ALERT_NOTE_MAX) : undefined}>
          <Input
            autoComplete="off"
            value={note}
            onChange={(event) => {
              setNote(event.target.value)
              setTooLong(false)
            }}
          />
        </Field>
      </form>
    </Dialog>
  )
}

/**
 * What staff may do about an alert (`can_act`: reception and administrators, while it is not resolved):
 * «تأكيد الاطلاع» / "Acknowledge" while it is open, and «إغلاق» / "Resolve"; `onAct` opens the owner's dialog.
 * When an action takes the focused button away, the focus goes on to the one left, else to the page's heading
 * (when the whole card leaves, its list moves the focus, F16-34).
 */
export function AlertActions({ alert, onAct, className }: { alert: TrackingAlert; onAct: (kind: AlertActionKind) => void; className?: string }) {
  const { t } = useTranslation('journey')
  const actionsRef = useRef<HTMLDivElement>(null)
  const offered = alert.can_act ? (alert.status === 'OPEN' ? 'both' : 'resolve') : 'none'
  const previous = useRef(offered)

  useEffect(() => {
    if (previous.current !== offered && isFocusLost()) {
      const next = actionsRef.current?.querySelector<HTMLElement>('button')
      if (next) next.focus()
      else focusPageHeading()
    }
    previous.current = offered
  }, [offered])

  return (
    <div ref={actionsRef} data-alert-actions="" className={className ?? 'flex flex-wrap gap-2 empty:hidden'}>
      {offered === 'both' && (
        <Button variant="secondary" size="sm" icon={<Eye aria-hidden="true" />} onClick={() => onAct('acknowledge')}>
          {t('alerts.acknowledge')}
        </Button>
      )}
      {offered !== 'none' && (
        <Button variant="secondary" size="sm" icon={<CircleCheck aria-hidden="true" />} onClick={() => onAct('resolve')}>
          {t('alerts.resolve')}
        </Button>
      )}
    </div>
  )
}

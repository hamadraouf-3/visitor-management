import { LogOut } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { Field } from '../../components/ui/Field'
import { Textarea } from '../../components/ui/Textarea'
import { useToast } from '../../components/ui/toastContext'
import { useFormErrors } from '../../hooks/useFormErrors'
import { useStableId } from '../../hooks/useStableId'
import type { Visit } from '../../types/api'
import { formatDateTime } from '../../utils/datetime'
import { characterCountLabel } from '../../utils/text'
import { REASON_MAX_LENGTH, REASON_MESSAGES, validateReason } from './checkOutForms'
import { useCheckOutStale } from './queries'
import { bulkCheckOutAt } from './visitActions'

/** Up to this many visitors are listed at once; the rest behind "Show all". */
const LISTED_AT_ONCE = 10

export interface StaleCheckOutDialogProps {
  /** The visitors from previous days whose visit has ended (`isBulkCheckOutCandidate`): whom the bulk check-out concerns. */
  visits: readonly Visit[]
  timeZone: string
  now: number
  /** The bulk check-out succeeded (called before the dialog closes). */
  onDone: () => void
  onClose: () => void
}

/**
 * "Check out remaining from previous days" (POST /reception/check-out-stale, method BULK): every
 * visitor still checked in from before today whose visit has ended (B57-71) is checked out at
 * their scheduled end (or their check-in, if later), with one required reason. A visitor from
 * an earlier day whose visit has not ended yet (a night visit) stays inside. It cannot be
 * undone, so the dialog lists who is checked out and at what time before anything happens.
 */
export function StaleCheckOutDialog({ visits, timeZone, now, onDone, onClose }: StaleCheckOutDialogProps) {
  const { t } = useTranslation('reception')
  const toast = useToast()
  const staleCheckOut = useCheckOutStale()
  const [reason, setReason] = useState('')
  const [showAll, setShowAll] = useState(false)
  const form = useFormErrors(staleCheckOut.error, { fields: { reason: 'reason' } })
  const formId = useStableId('stale-check-out')
  const listId = `${formId}-visitors`
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const count = visits.length
  const listed = showAll ? visits : visits.slice(0, LISTED_AT_ONCE)

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const message = validateReason(reason, REASON_MESSAGES.staleRequired)
    if (!form.validate(message ? { reason: message } : {})) return
    staleCheckOut.mutate(
      { reason: reason.trim() },
      {
        onSuccess: ({ checked_out }) => {
          toast.show({
            tone: 'success',
            title: checked_out === 0 ? t('stale.nobody') : t('stale.done', { count: checked_out }),
          })
          onDone()
          onClose()
        },
      },
    )
  }

  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      size="lg"
      title={t('stale.title')}
      // The one sentence an irreversible action keeps (decision 3); the list says who and when.
      description={t('stale.description')}
      dismissible={!staleCheckOut.isPending}
      initialFocusRef={reasonRef}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose} disabled={staleCheckOut.isPending} focusableWhenDisabled>
            {t('cancel')}
          </Button>
          <Button type="submit" form={formId} size="lg" icon={<LogOut aria-hidden="true" className="mirror-rtl" />} loading={staleCheckOut.isPending}>
            {t('stale.confirm', { count })}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <section aria-labelledby={`${listId}-heading`}>
          <h3 id={`${listId}-heading`} className="text-sm font-semibold text-fg">
            {t('stale.who')}
          </h3>
          <ul id={listId} className="mt-2 divide-y divide-border rounded-card border border-border">
            {listed.map((visit) => (
              <li key={visit.id} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                <span className="min-w-0">
                  <span className="font-medium break-words text-fg">{visit.visitor.full_name}</span>
                  <span className="block text-fg-muted">
                    {t('stale.hostAndIn', {
                      host: visit.host.full_name,
                      checkIn: visit.check_in_at ? formatDateTime(visit.check_in_at, timeZone) : '—',
                    })}
                  </span>
                </span>
                <span className="shrink-0 text-fg tabular-nums">{t('stale.out', { when: formatDateTime(bulkCheckOutAt(visit, now), timeZone) })}</span>
              </li>
            ))}
          </ul>
          {count > LISTED_AT_ONCE && (
            <Button variant="ghost" aria-expanded={showAll} aria-controls={listId} onClick={() => setShowAll((current) => !current)} className="mt-1 -ms-3">
              {showAll ? t('stale.showFewer') : t('stale.showAll', { count })}
            </Button>
          )}
        </section>
        <Field
          label={t('override.reason')}
          required
          hint={characterCountLabel(reason, REASON_MAX_LENGTH)}
          {...form.field('reason')}
        >
          <Textarea ref={reasonRef} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </form>
    </Dialog>
  )
}

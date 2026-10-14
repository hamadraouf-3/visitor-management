import { IdCard, LogIn } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { Field } from '../../components/ui/Field'
import { SuggestionChips } from '../../components/ui/SuggestionChips'
import { Textarea } from '../../components/ui/Textarea'
import { useFormErrors } from '../../hooks/useFormErrors'
import { useStableId } from '../../hooks/useStableId'
import type { Visit } from '../../types/api'
import { characterCountLabel } from '../../utils/text'
import { overrideReasonSuggestions, REASON_MAX_LENGTH, REASON_MESSAGES, validateReason } from './checkOutForms'
import { VisitFacts } from './VisitFacts'

export interface OverrideCheckInDialogProps {
  visit: Visit
  timeZone: string
  now: number
  /** Why the pass cannot be used (the scan's message, or the pass window). */
  context: string
  pending: boolean
  /** The failed check-in; field messages go to the reason, anything else to the alert. */
  error: unknown
  onConfirm: (reason: string) => void
  onClose: () => void
}

/**
 * "Check in anyway" (OVERRIDE, §6): a same-day check-in outside the pass window, or of a
 * no-show, with a required reason that is stored with the check-in and audited. Common
 * reasons are one tap (and stay editable), so the visitor does not wait while reception types
 * on an on-screen keyboard; focus starts on the first of them for the same reason. "Other"
 * moves to the reason field.
 */
export function OverrideCheckInDialog({ visit, timeZone, now, context, pending, error, onConfirm, onClose }: OverrideCheckInDialogProps) {
  const { t } = useTranslation('reception')
  const [reason, setReason] = useState('')
  const form = useFormErrors(error, { fields: { reason: 'reason' } })
  const formId = useStableId('override-check-in')
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const firstSuggestionRef = useRef<HTMLButtonElement>(null)
  const suggestions = overrideReasonSuggestions(visit, now)

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const message = validateReason(reason, REASON_MESSAGES.overrideRequired)
    if (!form.validate(message ? { reason: message } : {})) return
    onConfirm(reason.trim())
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('override.title')}
      description={context}
      dismissible={!pending}
      initialFocusRef={firstSuggestionRef}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose} disabled={pending} focusableWhenDisabled>
            {t('cancel')}
          </Button>
          <Button type="submit" form={formId} size="lg" icon={<LogIn aria-hidden="true" className="mirror-rtl" />} loading={pending}>
            {t('override.title')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <div className="flex flex-col gap-3">
          <p className="text-2xl leading-tight font-bold break-words text-fg">{visit.visitor.full_name}</p>
          <p className="flex items-center gap-2.5 rounded-control border-[1.5px] border-accent-strong bg-accent-surface px-3.5 py-2.5 font-semibold text-fg">
            <IdCard aria-hidden="true" className="size-5 shrink-0 text-accent-text" />
            {t('verifyId', { name: visit.visitor.full_name })}
          </p>
        </div>
        <VisitFacts visit={visit} timeZone={timeZone} now={now} showWindow surface="raised" />
        <SuggestionChips
          label={t('override.commonReasons')}
          suggestions={suggestions}
          value={reason}
          onPick={setReason}
          other={{
            label: t('override.other'),
            onSelect: () => {
              if (suggestions.includes(reason.trim())) setReason('')
              reasonRef.current?.focus()
            },
          }}
          firstChipRef={firstSuggestionRef}
        />
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

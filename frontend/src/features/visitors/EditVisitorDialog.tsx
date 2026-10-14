import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { Field } from '../../components/ui/Field'
import { Input } from '../../components/ui/Input'
import { useToast } from '../../components/ui/toastContext'
import { useFormErrors } from '../../hooks/useFormErrors'
import { useStableId } from '../../hooks/useStableId'
import type { Visitor, VisitorUpdate } from '../../types/api'
import type { FieldErrorCodes, ServerFieldPaths } from '../../utils/forms'
import { useUpdateVisitor } from './queries'
import {
  contactValuesFromVisitor,
  emailChanged,
  toVisitorUpdate,
  validateVisitorContact,
  visitorSavedMessage,
  type VisitorContactValues,
} from './visitorFields'

type VisitorField = keyof VisitorContactValues

const SERVER_FIELDS: ServerFieldPaths<VisitorField> = {
  fullName: 'full_name',
  email: 'email',
  phone: 'phone',
  companyName: 'company_name',
}
const FIELD_CODES: FieldErrorCodes<VisitorField> = { VISITOR_EXISTS: 'email' }

/** The dialog's purpose; its title comes from the catalog (`edit.intents`). */
const INTENTS = ['edit', 'correct-email'] as const

export interface EditVisitorDialogProps {
  visitor: Visitor
  onClose: () => void
  /**
   * `edit` (default): all contact details. `correct-email`: the same form, opened from a
   * failed or missing invitation, with focus on the email address.
   */
  intent?: (typeof INTENTS)[number]
  /** After a successful save, with what was sent (e.g. to follow an email change). */
  onSaved?: (updated: Visitor, body: VisitorUpdate) => void
}

/** Edit a visitor's contact details (PATCH /visitors/{id}); offered only when `permissions.can_edit`. */
export function EditVisitorDialog({ visitor, onClose, intent = 'edit', onSaved }: EditVisitorDialogProps) {
  const { t } = useTranslation('visitors')
  const toast = useToast()
  const update = useUpdateVisitor(visitor.id)
  const [values, setValues] = useState<VisitorContactValues>(() => contactValuesFromVisitor(visitor))
  const form = useFormErrors(update.error, { fields: SERVER_FIELDS, codes: FIELD_CODES })
  const formId = useStableId('edit-visitor')
  const emailRef = useRef<HTMLInputElement>(null)
  const newEmail = emailChanged(values, visitor) ? values.email.trim() : null

  const input = (key: VisitorField) => ({
    value: values[key],
    onChange: (event: { target: { value: string } }) => setValues((current) => ({ ...current, [key]: event.target.value })),
  })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateVisitorContact(values))) return
    const body = toVisitorUpdate(values, visitor)
    if (Object.keys(body).length === 0) {
      onClose()
      return
    }
    update.mutate(body, {
      onSuccess: (updated) => {
        toast.show({ tone: 'success', title: t('edit.savedTitle'), description: visitorSavedMessage(body, updated) })
        onSaved?.(updated, body)
        onClose()
      },
    })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={intent === 'correct-email' ? t('edit.intents.correctEmail.title') : t('edit.intents.edit.title')}
      dismissible={!update.isPending}
      initialFocusRef={intent === 'correct-email' ? emailRef : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending} focusableWhenDisabled>
            {t('edit.discard')}
          </Button>
          <Button type="submit" form={formId} loading={update.isPending}>
            {intent === 'correct-email' ? t('edit.saveAndSend') : t('edit.save')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <Field label={t('fields.fullName')} required {...form.field('fullName')}>
          <Input autoComplete="off" {...input('fullName')} />
        </Field>
        <Field label={t('fields.email')} optional {...form.field('email')}>
          <Input ref={emailRef} type="email" inputMode="email" autoComplete="off" spellCheck={false} {...input('email')} />
        </Field>
        {/* What a changed address does, once, while it is changed: the QR codes sent before stop working. */}
        {newEmail !== null && (
          <Alert tone="warning" role="status" title={newEmail ? t('edit.newInvitationsTitle') : t('edit.previousQrStops')}>
            {newEmail ? t('edit.previousQrStops') : undefined}
          </Alert>
        )}
        <Field label={t('fields.phone')} optional {...form.field('phone')}>
          <Input type="tel" inputMode="tel" autoComplete="off" {...input('phone')} />
        </Field>
        <Field label={t('fields.company')} optional {...form.field('companyName')}>
          <Input autoComplete="off" {...input('companyName')} />
        </Field>
      </form>
    </Dialog>
  )
}

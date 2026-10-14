import { Plus } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { Field } from '../../components/ui/Field'
import { Input } from '../../components/ui/Input'
import { useStableId } from '../../hooks/useStableId'
import type { Visitor } from '../../types/api'
import { VisitorPicker } from '../visits/pickers'
import { RegisteredVisitorAction } from './RegisteredVisitorAction'
import { SelectedVisitorSummary } from './SelectedVisitorSummary'
import type { VisitorContactValues } from './visitorFields'

/** The fields of the visitor part of a form: the returning-visitor picker and the new visitor's details. */
export type VisitorSourceField = 'existingVisitor' | keyof VisitorContactValues

export interface VisitorSourceFieldsProps {
  /** The chosen returning visitor; null while a new visitor is entered. */
  visitor: Visitor | null
  onVisitorChange: (visitor: Visitor | null) => void
  /** The new visitor's details as typed. */
  contact: VisitorContactValues
  onContactChange: (key: keyof VisitorContactValues, value: string) => void
  /** Each field's control id and error (`useFormErrors(...).field`). */
  field: (name: VisitorSourceField) => { id: string; error: string | undefined }
  /** A hint under the picker, e.g. while a pre-filled visitor loads (it has none otherwise: its placeholder says what to type). */
  pickerHint?: string
  /** The invitation is emailed: Email is required (its validation message says why when it is missing). */
  emailRequired?: boolean
  /**
   * Company, phone and email wait behind "Add contact details (optional)" while `open` is false
   * (the walk-in form, built for speed). Without it they are always shown (the invite form).
   */
  contactDetails?: { open: boolean; onOpen: () => void }
  /** The failed create request: after 409 VISITOR_EXISTS the registered visitor is offered (B57-70). */
  error: unknown
  /** Use the registered visitor instead of the details typed (the form drops its failed request). */
  onRegisteredVisitor: (visitor: Visitor) => void
}

/**
 * The visitor part of the invite and walk-in forms (lookup first): the returning-visitor
 * typeahead, then either the chosen visitor's details with "Enter a new visitor instead", or
 * "or enter a new visitor" and the new visitor's fields in one order (full name, company,
 * phone, email). After the server refuses an email address registered under another name, it
 * offers that visitor. Rendered as siblings, so they take the gap of the card around them.
 */
export function VisitorSourceFields({
  visitor,
  onVisitorChange,
  contact,
  onContactChange,
  field,
  pickerHint,
  emailRequired = false,
  contactDetails,
  error,
  onRegisteredVisitor,
}: VisitorSourceFieldsProps) {
  const { t } = useTranslation('visitors')
  const contactId = useStableId('visitor-contact')
  const companyRef = useRef<HTMLInputElement>(null)
  const focusCompany = useRef(false)
  const contactShown = contactDetails?.open ?? true

  // "Add contact details" gives way to the fields it reveals; focus moves on to the first one.
  useEffect(() => {
    if (!contactShown || !focusCompany.current) return
    focusCompany.current = false
    companyRef.current?.focus()
  }, [contactShown])

  const input = (key: keyof VisitorContactValues) => ({
    value: contact[key],
    onChange: (event: { target: { value: string } }) => onContactChange(key, event.target.value),
  })

  return (
    <>
      <Field label={t('fields.returning')} optional hint={pickerHint} {...field('existingVisitor')}>
        <VisitorPicker value={visitor} onChange={onVisitorChange} placeholder={t('fields.returningPlaceholder')} />
      </Field>

      {visitor ? (
        <SelectedVisitorSummary visitor={visitor} onClear={() => onVisitorChange(null)} />
      ) : (
        <>
          <div className="flex items-center gap-3 text-sm text-fg-muted">
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
            <span>{t('fields.orNew')}</span>
            <span aria-hidden="true" className="h-px flex-1 bg-border" />
          </div>
          {/* Email comes last, so what depends on it (the invite's delivery choice) follows it directly. */}
          <div id={contactId} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('fields.fullName')} required {...field('fullName')}>
              <Input autoComplete="off" {...input('fullName')} />
            </Field>
            {contactShown && (
              <>
                <Field label={t('fields.company')} optional {...field('companyName')}>
                  <Input ref={companyRef} autoComplete="off" {...input('companyName')} />
                </Field>
                <Field label={t('fields.phone')} optional {...field('phone')}>
                  <Input type="tel" inputMode="tel" autoComplete="off" {...input('phone')} />
                </Field>
                {/* The error after a failed submit says why the address is needed. */}
                <Field label={t('fields.email')} required={emailRequired} optional={!emailRequired} {...field('email')}>
                  <Input type="email" inputMode="email" autoComplete="off" spellCheck={false} {...input('email')} />
                </Field>
              </>
            )}
          </div>
          {contactShown ? (
            <RegisteredVisitorAction error={error} onSelect={onRegisteredVisitor} />
          ) : (
            <Button
              variant="ghost"
              icon={<Plus aria-hidden="true" />}
              aria-expanded={false}
              aria-controls={contactId}
              onClick={() => {
                focusCompany.current = true
                contactDetails?.onOpen()
              }}
              className="-mx-3 self-start"
            >
              {t('fields.addContact')}
            </Button>
          )}
        </>
      )}
    </>
  )
}

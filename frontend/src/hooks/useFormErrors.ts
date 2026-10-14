import { useEffect, useState } from 'react'
import { focusFirstControl } from '../utils/focus'
import {
  hasErrors,
  invalidFields,
  mergeFormErrors,
  resolveServerErrors,
  type FieldErrorCodes,
  type FormErrors,
  type ServerFieldPaths,
} from '../utils/forms'
import { useStableId } from './useStableId'

export interface FormErrorsConfig<K extends string> {
  /** Every field of the form, with the server path(s) that report it (see ServerFieldPaths). */
  fields: ServerFieldPaths<K>
  /** Error codes shown on one field instead of the form alert. */
  codes?: FieldErrorCodes<K>
}

export interface FormErrorsState<K extends string> {
  /** Message per field: the client-side one, else the server's. */
  errors: FormErrors<K>
  /** Message for the form-level alert (errors no field shows), or null. */
  formError: string | null
  /** Props for the field's `<Field>` (or DateField, DateTimeField, RadioGroup): control id and error. */
  field: (name: K) => { id: string; error: string | undefined }
  /**
   * Records the client-side validation of a submit attempt. Returns true when the form may
   * be sent; otherwise the first invalid control is focused once its message is on screen.
   */
  validate: (clientErrors: FormErrors<K>) => boolean
  /**
   * Replaces the client-side messages without moving focus: for re-checking the form as it is
   * corrected after a failed submit, so a message goes as soon as its field is right.
   */
  refresh: (clientErrors: FormErrors<K>) => void
  /** Whether a submit was refused by the client-side checks (since the hook mounted). */
  attempted: boolean
}

/**
 * Field errors for a form that submits through a mutation: merges client-side validation
 * with the server's 422 field messages (§8.2 `details.fields`), returns what only the form
 * alert can show, and moves focus to the first invalid control after a failed submit, from
 * either side. Focus moves after the render that shows the messages, so assistive technology
 * reads each control together with its error.
 */
export function useFormErrors<K extends string>(serverError: unknown, { fields, codes }: FormErrorsConfig<K>): FormErrorsState<K> {
  const idPrefix = useStableId('form')
  const [clientErrors, setClientErrors] = useState<FormErrors<K>>({})
  // A new object per request, so asking twice for the same fields focuses twice.
  const [focusRequest, setFocusRequest] = useState<{ ids: string[] } | null>(null)
  const [seenServerError, setSeenServerError] = useState<unknown>(serverError)
  const [attempted, setAttempted] = useState(false)

  const names = Object.keys(fields) as K[]
  const fieldId = (name: K) => `${idPrefix}-${name}`
  const server = resolveServerErrors(serverError, fields, codes)
  const errors = mergeFormErrors(names, clientErrors, server.fieldErrors)

  // Adjusting state while rendering (instead of in an effect) when a different error arrives.
  if (serverError !== seenServerError) {
    setSeenServerError(serverError)
    if (hasErrors(server.fieldErrors)) setFocusRequest({ ids: invalidFields(names, server.fieldErrors).map(fieldId) })
  }

  useEffect(() => {
    if (focusRequest) focusFirstControl(focusRequest.ids)
  }, [focusRequest])

  return {
    errors,
    formError: server.formError,
    field: (name) => ({ id: fieldId(name), error: errors[name] }),
    validate: (validation) => {
      setClientErrors(validation)
      const invalid = invalidFields(names, validation)
      if (invalid.length === 0) return true
      setAttempted(true)
      setFocusRequest({ ids: invalid.map(fieldId) })
      return false
    },
    refresh: setClientErrors,
    attempted,
  }
}

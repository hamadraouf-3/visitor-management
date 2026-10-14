import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client'
import { i18n } from '../i18n'
import { hasErrors, invalidFields, maxLengthMessage, mergeFormErrors, resolveServerErrors, type ServerFieldPaths } from './forms'

type VisitorField = 'fullName' | 'email' | 'reason' | 'note'

const PATHS: ServerFieldPaths<VisitorField> = {
  fullName: 'visitor.full_name',
  email: ['visitor.email', 'email'],
  reason: 'reason',
  note: [],
}

function validationError(fields: Record<string, unknown>, fieldCodes?: Record<string, unknown>): ApiError {
  return new ApiError({
    status: 422,
    code: 'VALIDATION_ERROR',
    message: 'Please correct the highlighted fields.',
    details: fieldCodes === undefined ? { fields } : { fields, field_codes: fieldCodes },
  })
}

describe('hasErrors', () => {
  it('is true only when some field has a message', () => {
    expect(hasErrors({})).toBe(false)
    expect(hasErrors({ email: undefined, name: '' })).toBe(false)
    expect(hasErrors({ email: undefined, name: 'Enter a name.' })).toBe(true)
  })
})

describe('resolveServerErrors', () => {
  it('has nothing to show without an error', () => {
    expect(resolveServerErrors(null, PATHS)).toEqual({ fieldErrors: {}, formError: null })
  })

  it('puts field messages on their fields, including nested and alternative paths', () => {
    const error = validationError({ 'visitor.full_name': 'This field is required.', email: 'Enter a valid email address.', reason: 'Choose a reason.' })

    expect(resolveServerErrors(error, PATHS)).toEqual({
      fieldErrors: { fullName: 'This field is required.', email: 'Enter a valid email address.', reason: 'Choose a reason.' },
      formError: null,
    })
  })

  it('keeps the first message when two paths report the same field', () => {
    const error = validationError({ 'visitor.email': 'First.', email: 'Second.' })

    expect(resolveServerErrors(error, PATHS).fieldErrors).toEqual({ email: 'First.' })
  })

  it('sends messages for paths the form does not show to the form alert, without duplicates', () => {
    const error = validationError({
      reason: 'Choose a reason.',
      body: 'Choose an existing visitor or enter a new one.',
      'visitor.company_name': 'Choose an existing visitor or enter a new one.',
    })

    expect(resolveServerErrors(error, PATHS)).toEqual({
      fieldErrors: { reason: 'Choose a reason.' },
      formError: 'Choose an existing visitor or enter a new one.',
    })
  })

  it('reports a malformed body (`fields.body`) in the form alert', () => {
    const error = validationError({ body: 'The request body is not valid JSON.' })

    expect(resolveServerErrors(error, PATHS)).toEqual({ fieldErrors: {}, formError: 'The request body is not valid JSON.' })
  })

  it('shows errors without field details in the form alert', () => {
    const error = new ApiError({ status: 409, code: 'VISIT_NOT_EDITABLE', message: 'Only scheduled visits can be changed.' })

    expect(resolveServerErrors(error, PATHS)).toEqual({ fieldErrors: {}, formError: 'Only scheduled visits can be changed.' })
  })

  it('ignores non-string field messages', () => {
    const error = validationError({ reason: 42 })

    expect(resolveServerErrors(error, PATHS)).toEqual({ fieldErrors: {}, formError: 'Please correct the highlighted fields.' })
  })

  it('puts an error code that describes one field on that field', () => {
    const error = new ApiError({ status: 400, code: 'INVALID_CURRENT_PASSWORD', message: 'Your current password is incorrect.' })

    expect(resolveServerErrors(error, { current: 'current_password' }, { INVALID_CURRENT_PASSWORD: 'current' })).toEqual({
      fieldErrors: { current: 'Your current password is incorrect.' },
      formError: null,
    })
  })

  it('shows each field error in Arabic by its code, the form alert too, and keeps the server’s words without one', async () => {
    await i18n.changeLanguage('ar')
    const error = validationError(
      {
        'visitor.full_name': 'Enter at most 200 characters.',
        email: 'Email address is too long.',
        reason: 'A rule only a newer server knows.',
        body: 'Choose an existing visitor or enter the visitor’s details.',
      },
      {
        'visitor.full_name': { code: 'too_long', params: { max: 200 } },
        email: { code: 'too_long', params: { max: 320 } },
        reason: { code: 'brand_new_rule', params: {} },
        body: { code: 'visitor_required', params: {} },
      },
    )

    expect(resolveServerErrors(error, PATHS)).toEqual({
      fieldErrors: { fullName: 'أدخل 200 حرف على الأكثر.', email: 'أدخل 320 حرفًا على الأكثر.', reason: 'A rule only a newer server knows.' },
      formError: 'اختر زائرًا مسجّلًا أو أدخل بيانات الزائر.',
    })
  })

  it('shows the server’s English words in English, codes or not', () => {
    const error = validationError({ email: 'Email address is too long.' }, { email: { code: 'too_long', params: { max: 320 } } })

    expect(resolveServerErrors(error, PATHS).fieldErrors).toEqual({ email: 'Email address is too long.' })
  })

  it('uses the generic message for thrown values that are not API errors', () => {
    expect(resolveServerErrors(new TypeError('boom'), PATHS)).toEqual({
      fieldErrors: {},
      formError: 'Something went wrong. Please try again.',
    })
  })
})

describe('mergeFormErrors', () => {
  it('prefers the client message and falls back to the server message per field', () => {
    const merged = mergeFormErrors<VisitorField>(
      ['fullName', 'email', 'reason', 'note'],
      { fullName: 'Enter a name.', email: undefined },
      { fullName: 'This field is required.', email: 'Enter a valid email address.' },
    )

    expect(merged).toEqual({ fullName: 'Enter a name.', email: 'Enter a valid email address.' })
  })
})

describe('invalidFields', () => {
  it('lists fields with a message in the given order', () => {
    expect(invalidFields<VisitorField>(['fullName', 'email', 'reason'], { reason: 'Choose a reason.', fullName: 'Enter a name.' })).toEqual([
      'fullName',
      'reason',
    ])
  })
})

describe('maxLengthMessage', () => {
  it('says the limit in words, for every form (visitor fields, purposes, reasons)', () => {
    expect(maxLengthMessage(300)).toBe('Enter at most 300 characters.')
  })
})

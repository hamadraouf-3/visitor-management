import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import { makeVisitor, VISITOR_ID } from '../../test/fixtures'
import {
  contactValuesFromVisitor,
  registeredVisitorId,
  emailChanged,
  foldPersonName,
  sameVisitorName,
  toVisitorInput,
  toVisitorUpdate,
  validateVisitorContact,
  visitorSavedMessage,
} from './visitorFields'

const visitor = makeVisitor()

describe('visitor contact fields', () => {
  it('validates name, email format and lengths; email is required only when asked', () => {
    const values = contactValuesFromVisitor(visitor)
    expect(validateVisitorContact(values)).toEqual({})
    expect(validateVisitorContact({ ...values, email: '' })).toEqual({})
    expect(validateVisitorContact({ ...values, email: '' }, { emailRequiredMessage: 'Needed.' })).toEqual({ email: 'Needed.' })
    expect(validateVisitorContact({ ...values, email: 'not-an-address' }).email).toMatch(/valid email/)
    // Special-use test domains are accepted, as by the server (B1-22).
    expect(validateVisitorContact({ ...values, email: 'host@demo.local' })).toEqual({})
    expect(validateVisitorContact({ ...values, fullName: 'x'.repeat(201) })).toEqual({ fullName: 'Enter at most 200 characters.' })
    // A name of invisible characters only would put a blank line on the evacuation list.
    expect(validateVisitorContact({ ...values, fullName: '\u200b\u2060' }).fullName).toBe('Enter the visitor’s full name.')
  })

  it('builds the inline visitor without empty optional fields', () => {
    expect(toVisitorInput({ fullName: ' Omar ', email: '', phone: ' 079 ', companyName: '' })).toEqual({ full_name: 'Omar', phone: '079' })
  })
})

describe('toVisitorUpdate', () => {
  it('sends only what changed and clears emptied optional fields with null', () => {
    const values = { ...contactValuesFromVisitor(visitor), phone: '', companyName: 'Orbit Labs GmbH' }
    expect(toVisitorUpdate(values, visitor)).toEqual({ phone: null, company_name: 'Orbit Labs GmbH' })
    expect(toVisitorUpdate(contactValuesFromVisitor(visitor), visitor)).toEqual({})
  })

  it('treats a change of letter case as the same email address', () => {
    const values = { ...contactValuesFromVisitor(visitor), email: 'Elodie@Orbit.Example' }
    expect(emailChanged(values, visitor)).toBe(false)
    expect(toVisitorUpdate(values, visitor)).toEqual({})
    expect(toVisitorUpdate({ ...values, email: 'e.martin@orbit.example' }, visitor)).toEqual({ email: 'e.martin@orbit.example' })
    expect(toVisitorUpdate({ ...values, email: ' ' }, visitor)).toEqual({ email: null })
  })
})

describe('visitorSavedMessage', () => {
  it('mentions invitations only for an email change, without claiming there are scheduled visits', () => {
    expect(visitorSavedMessage({ phone: null }, visitor)).toBeUndefined()
    expect(visitorSavedMessage({ email: 'e.martin@orbit.example' }, makeVisitor({ email: 'e.martin@orbit.example' }))).toBe(
      'Any scheduled visits of Élodie Martin get a new invitation and QR code at e.martin@orbit.example.',
    )
    expect(visitorSavedMessage({ email: null }, makeVisitor({ email: null }))).toBe(
      'QR codes of scheduled visits sent to the previous address no longer work.',
    )
  })
})

describe('person names', () => {
  it('compare as the server folds them: case, accents, Arabic letter variants and spacing do not count', () => {
    expect(foldPersonName('  Élodie   MARTIN ')).toBe('elodie martin')
    expect(sameVisitorName('Elodie Martin', 'élodie martin')).toBe(true)
    // Alef with hamza above / bare alef, teh marbuta / heh, alef maksura / yeh, tatweel.
    const withVariants = String.fromCodePoint(0x0623, 0x0633, 0x0627, 0x0645, 0x0629, 0x0020, 0x0645, 0x0640, 0x0648, 0x0633, 0x0649)
    const plain = String.fromCodePoint(0x0627, 0x0633, 0x0627, 0x0645, 0x0647, 0x0020, 0x0645, 0x0648, 0x0633, 0x064a)
    expect(sameVisitorName(withVariants, plain)).toBe(true)
    expect(sameVisitorName('Karim Fail', 'Sami Nasser')).toBe(false)
  })
})

const exists = (details: Record<string, unknown>) => new ApiError({ status: 409, code: 'VISITOR_EXISTS', message: 'Registered under another name.', details })

describe('registeredVisitorId (B57-70)', () => {
  it('names the registered visitor a refused address belongs to', () => {
    expect(registeredVisitorId(exists({ visitor_id: VISITOR_ID }))).toBe(VISITOR_ID)
  })

  it('is null without a usable id (EMPLOYEE-only callers get no details) and for other errors', () => {
    expect(registeredVisitorId(exists({}))).toBeNull()
    expect(registeredVisitorId(exists({ visitor_id: 'not-an-id' }))).toBeNull()
    expect(registeredVisitorId(new ApiError({ status: 409, code: 'CONFLICT', message: 'x', details: { visitor_id: VISITOR_ID } }))).toBeNull()
    expect(registeredVisitorId(new Error('offline'))).toBeNull()
  })
})

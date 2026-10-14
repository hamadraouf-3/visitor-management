import { isApiError } from '../../api/client'
import { i18n } from '../../i18n'
import { lazyTexts } from '../../i18n/lazyTexts'
import type { Visitor, VisitorUpdate } from '../../types/api'
import { maxLengthMessage, type FormErrors } from '../../utils/forms'
import { isBlankText } from '../../utils/text'
import { isUuid } from '../../utils/ids'

/**
 * Labels of `Visitor.stats` (B24-12), the same on the list and the profile: the count covers
 * every visit in the caller's scope, whatever its status; the date is the last actual arrival.
 */
const t = i18n.getFixedT(null, ['visitors', 'auth'])

export const VISITOR_STAT_LABELS = lazyTexts({ total: () => t('stats.total'), lastCheckIn: () => t('stats.lastCheckIn') })

/** Column limits of `visitors` (§4); the server enforces the same. */
export const VISITOR_LIMITS = {
  fullName: 200,
  email: 320,
  phone: 40,
  companyName: 200,
} as const

// Deliberately permissive (accepts e.g. `.local` test domains): the server validates addresses.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The visitor's contact details as typed in a form. */
export interface VisitorContactValues {
  fullName: string
  email: string
  phone: string
  companyName: string
}

export const EMPTY_VISITOR_CONTACT: VisitorContactValues = { fullName: '', email: '', phone: '', companyName: '' }

export interface VisitorContactRules {
  /** Set when an email is required, with the message that explains why. */
  emailRequiredMessage?: string
}

export function validateVisitorContact(
  values: VisitorContactValues,
  { emailRequiredMessage }: VisitorContactRules = {},
): FormErrors<keyof VisitorContactValues> {
  const errors: FormErrors<keyof VisitorContactValues> = {}
  const fullName = values.fullName.trim()
  const email = values.email.trim()

  if (isBlankText(fullName)) errors.fullName = t('validation.fullNameRequired')
  else if (fullName.length > VISITOR_LIMITS.fullName) errors.fullName = maxLengthMessage(VISITOR_LIMITS.fullName)

  if (!email) {
    if (emailRequiredMessage) errors.email = emailRequiredMessage
  } else if (email.length > VISITOR_LIMITS.email) {
    errors.email = maxLengthMessage(VISITOR_LIMITS.email)
  } else if (!EMAIL_PATTERN.test(email)) {
    errors.email = t('auth:validation.emailInvalid', { example: 'name@company.com' })
  }

  if (values.phone.trim().length > VISITOR_LIMITS.phone) errors.phone = maxLengthMessage(VISITOR_LIMITS.phone)
  if (values.companyName.trim().length > VISITOR_LIMITS.companyName) errors.companyName = maxLengthMessage(VISITOR_LIMITS.companyName)
  return errors
}

export function contactValuesFromVisitor(visitor: Visitor): VisitorContactValues {
  return {
    fullName: visitor.full_name,
    email: visitor.email ?? '',
    phone: visitor.phone ?? '',
    companyName: visitor.company_name ?? '',
  }
}

/** Email addresses are stored lowercase; a change of letter case is not a new address. */
export function emailChanged(values: VisitorContactValues, visitor: Visitor): boolean {
  return values.email.trim().toLowerCase() !== (visitor.email ?? '')
}

/**
 * PATCH body with only what changed; a cleared optional field is sent as `null`. Call after
 * `validateVisitorContact` passed.
 */
export function toVisitorUpdate(values: VisitorContactValues, visitor: Visitor): VisitorUpdate {
  const update: VisitorUpdate = {}
  const fullName = values.fullName.trim()
  const phone = values.phone.trim()
  const companyName = values.companyName.trim()
  if (fullName !== visitor.full_name) update.full_name = fullName
  if (emailChanged(values, visitor)) update.email = values.email.trim() || null
  if (phone !== (visitor.phone ?? '')) update.phone = phone || null
  if (companyName !== (visitor.company_name ?? '')) update.company_name = companyName || null
  return update
}

/**
 * The confirmation after saving a visitor. A new address re-sends the invitations of the
 * visitor's SCHEDULED visits (D-19), and a cleared one only revokes their QR codes; the client
 * does not know whether there are such visits, so the wording does not claim there are.
 */
export function visitorSavedMessage(body: VisitorUpdate, updated: Visitor): string | undefined {
  if (!('email' in body)) return undefined
  if (updated.email) return t('edit.savedNewEmail', { name: updated.full_name, email: updated.email })
  return t('edit.savedEmailCleared')
}

// Arabic letter variants the server's search folding treats as one letter (B24-10), by code
// point (written as numbers: right-to-left letters in source are hard to read). The alef
// variants with hamza or madda decompose under NFKD and lose their mark like any accent.
const ARABIC_NAME_FOLDS = new Map<number, string>([
  [0x0671, String.fromCodePoint(0x0627)], // alef wasla → alef
  [0x0629, String.fromCodePoint(0x0647)], // teh marbuta → heh
  [0x0649, String.fromCodePoint(0x064a)], // alef maksura → yeh
  [0x0640, ''], // tatweel
])

/**
 * A person's name folded as the server folds names for search and ordering (B24-10, B24-78):
 * case, accents, Arabic letter variants and spacing do not count, so "élodie  martin" and
 * "Elodie Martin" are the same name.
 */
export function foldPersonName(name: string): string {
  const withoutMarks = name.normalize('NFKD').toLowerCase().normalize('NFKD').replace(/\p{Mn}/gu, '')
  return Array.from(withoutMarks, (character) => ARABIC_NAME_FOLDS.get(character.codePointAt(0) ?? 0) ?? character)
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Whether two spellings name the same person by `foldPersonName`. */
export function sameVisitorName(a: string, b: string): boolean {
  return foldPersonName(a) === foldPersonName(b)
}

/** Trimmed contact details with empty optional fields left out (inline visitor of `VisitCreate`). */
export function toVisitorInput(values: VisitorContactValues): { full_name: string; email?: string; phone?: string; company_name?: string } {
  const email = values.email.trim()
  const phone = values.phone.trim()
  const companyName = values.companyName.trim()
  return {
    full_name: values.fullName.trim(),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(companyName ? { company_name: companyName } : {}),
  }
}

/**
 * The registered visitor a refused new-visitor entry points to: 409 `VISITOR_EXISTS` names
 * them in `details.visitor_id` for callers who read every visitor (B57-70: the address belongs
 * to a visitor registered under another name). Null for any other error, and for EMPLOYEE-only
 * callers, who get no details (§7.5).
 */
export function registeredVisitorId(error: unknown): string | null {
  if (!isApiError(error) || error.code !== 'VISITOR_EXISTS') return null
  const id = error.details.visitor_id
  return typeof id === 'string' && isUuid(id) ? id : null
}

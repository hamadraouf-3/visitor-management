import { i18n } from '../../i18n'
import { lazyTexts } from '../../i18n/lazyTexts'
import type { DepartmentRef, Host, Visit, Visitor, WalkInCreate, WalkInReason } from '../../types/api'
import { addMinutesUtc, companyToday, wallTimeToUtc } from '../../utils/datetime'
import { maxLengthMessage, type FormErrors } from '../../utils/forms'
import { isBlankText } from '../../utils/text'
import {
  EMPTY_VISITOR_CONTACT,
  toVisitorInput,
  validateVisitorContact,
  type VisitorContactValues,
} from '../visitors/visitorFields'
import { toAreasInput, type AreaSelection } from '../accessAreas/accessAreas'
import { PURPOSE_MAX_LENGTH } from '../visits/inviteForm'
import { walkInReasonLabel } from '../visits/labels'
import { MAX_VISIT_DURATION_MS } from '../visits/schedule'
import { REASON_MAX_LENGTH } from './checkOutForms'

const t = i18n.getFixedT(null, 'reception')

/** §8.1 `WalkInCreate.reason`, in the order of the quick-pick. */
export const WALK_IN_REASONS = [
  'NO_INVITATION',
  'EARLY_ARRIVAL',
  'LATE_ARRIVAL',
  'LOST_PASS',
  'DELIVERY',
  'OTHER',
] as const satisfies readonly WalkInReason[]

/** The reason quick-pick; each label in the UI language when read. */
export const WALK_IN_REASON_OPTIONS = WALK_IN_REASONS.map((reason) => ({
  value: reason,
  get label() {
    return walkInReasonLabel(reason)
  },
}))

/**
 * How long a walk-in is expected to stay: a length from now, until the end of the office day,
 * or an end chosen with the date and time fields ("Other"). A walk-in almost always ends
 * today, so the date is asked for only when it does not.
 */
export type WalkInStay = '30m' | '1h' | '2h' | 'office-day' | 'other'

/** §8.1: "default now + 1h in UI". */
export const DEFAULT_WALK_IN_STAY: WalkInStay = '1h'

const STAY_MINUTES = { '30m': 30, '1h': 60, '2h': 120 } as const

/**
 * The end of the office day offered as "Until 17:00" (company time). The contract has no
 * opening-hours setting; a site whose day ends otherwise uses "Other".
 */
export const OFFICE_DAY_END = '17:00'

/** "Until 17:00" is offered while the office day has at least this long left. */
const OFFICE_DAY_MIN_LEFT_MS = 30 * 60_000

export interface WalkInStayOption {
  value: WalkInStay
  label: string
}

/** The end of today's office day (company time), as an instant. */
function officeDayEnd(now: number, timeZone: string): number | null {
  const end = wallTimeToUtc(`${companyToday(timeZone, now)}T${OFFICE_DAY_END}`, timeZone)
  return end === null ? null : Date.parse(end)
}

/**
 * The stays offered at `now`: "Until 17:00" only while the office day has 30 minutes or more
 * left, or while it is the one chosen (the form then says the time has passed when it is sent).
 */
export function walkInStayOptions(now: number, timeZone: string, selected: WalkInStay | null = null): WalkInStayOption[] {
  const end = officeDayEnd(now, timeZone)
  const officeDayLeft = end !== null && end - now >= OFFICE_DAY_MIN_LEFT_MS
  return [
    { value: '30m', label: t('walkIn.stay.30m') },
    { value: '1h', label: t('walkIn.stay.1h') },
    { value: '2h', label: t('walkIn.stay.2h') },
    ...(officeDayLeft || selected === 'office-day' ? [{ value: 'office-day' as const, label: t('walkIn.stay.until', { time: OFFICE_DAY_END }) }] : []),
    { value: 'other', label: t('walkIn.stay.other') },
  ]
}

export interface WalkInFormValues extends VisitorContactValues {
  /** A returning visitor (lookup first, §10); the contact fields are then unused. */
  existingVisitor: Visitor | null
  host: Host | null
  /** The chosen department; '' = none chosen (see `inviteDepartmentChoice`). */
  departmentId: string
  /**
   * The department was set on purpose (picked in the field, or the scanned visit's), not taken
   * over from the host: it is then always sent, also when it is the host's own.
   */
  departmentChosen: boolean
  purpose: string
  stay: WalkInStay
  /** The end chosen with the date and time fields (stay "other"): a UTC instant, shown in company time. */
  expectedEnd: string | null
  reason: WalkInReason | null
  /** Required for OTHER. */
  reasonNote: string
  /**
   * Phase 16: the allowed areas as reception chose them; null while untouched: the field then shows (and
   * sends) the department's floor, and follows a change of department.
   */
  accessAreas: AreaSelection | null
}

export type WalkInField =
  | 'existingVisitor'
  | keyof VisitorContactValues
  | 'host'
  | 'department'
  | 'purpose'
  | 'expectedEnd'
  | 'reason'
  | 'reasonNote'
  | 'areas'

/** A host known from a scanned visit by id and name only; the form looks up the host record. */
export interface HostReference {
  id: string
  full_name: string
}

/** What a walk-in starts with when reception arrives from a scan result, a list or the visitor search. */
export interface WalkInPrefill {
  visitor?: Visitor
  /** A visitor known only by id (a scanned visit); the form loads the record. */
  visitorId?: string
  host?: Host
  /** The host of a scanned visit; the form loads the host record (with the host's own department). */
  hostRef?: HostReference
  /** A department chosen for the visitor (the scanned visit's), kept even when it is not the host's. */
  department?: DepartmentRef
  purpose?: string
  reason?: WalkInReason
}

export function initialWalkInValues(prefill: WalkInPrefill = {}): WalkInFormValues {
  return {
    ...EMPTY_VISITOR_CONTACT,
    existingVisitor: prefill.visitor ?? null,
    host: prefill.host ?? null,
    departmentId: prefill.department?.id ?? prefill.host?.department?.id ?? '',
    departmentChosen: prefill.department !== undefined,
    purpose: prefill.purpose ?? '',
    stay: DEFAULT_WALK_IN_STAY,
    expectedEnd: null,
    reason: prefill.reason ?? null,
    reasonNote: '',
    accessAreas: null,
  }
}

/**
 * The expected end the walk-in is registered with, as a UTC instant: `now` plus the picked
 * length (measured when the form is sent, not when it was opened), today's office-day end, or
 * the date and time chosen under "Other" (null while incomplete).
 */
export function walkInExpectedEnd(values: Pick<WalkInFormValues, 'stay' | 'expectedEnd'>, now: number, timeZone: string): string | null {
  switch (values.stay) {
    case '30m':
    case '1h':
    case '2h':
      return addMinutesUtc(now, STAY_MINUTES[values.stay])
    case 'office-day': {
      const end = officeDayEnd(now, timeZone)
      return end === null ? null : new Date(end).toISOString()
    }
    case 'other':
      return values.expectedEnd
  }
}

/**
 * A new stay. Choosing "Other" starts the date and time fields at the end picked so far
 * (one hour from now by default), so they are adjusted rather than filled from nothing.
 */
export function withWalkInStay(values: WalkInFormValues, stay: WalkInStay, now: number, timeZone: string): WalkInFormValues {
  if (stay !== 'other') return { ...values, stay }
  return { ...values, stay, expectedEnd: values.expectedEnd ?? walkInExpectedEnd(values, now, timeZone) }
}

/** Whether a new visitor's optional contact details hold anything (the form then shows them). */
export function hasContactDetails(values: Pick<VisitorContactValues, 'companyName' | 'phone' | 'email'>): boolean {
  return [values.companyName, values.phone, values.email].some((value) => value.trim() !== '')
}

/**
 * A walk-in for the visitor of a scanned visit that cannot be checked in (cancelled, completed,
 * another day, inactive host). The visit names its host only by id and name, so the form looks
 * the host record up; the visit's department is kept as a choice of its own, because it need
 * not be the host's (a visit can be booked for another department).
 */
export function walkInPrefillFromVisit(
  visit: Visit | null,
  { withHost, reason }: { withHost: boolean; reason: WalkInReason | null },
): WalkInPrefill {
  if (!visit) return reason ? { reason } : {}
  return {
    visitorId: visit.visitor.id,
    purpose: visit.purpose,
    ...(withHost ? { hostRef: { id: visit.host.id, full_name: visit.host.full_name } } : {}),
    ...(withHost && visit.department ? { department: visit.department } : {}),
    ...(reason ? { reason } : {}),
  }
}

/**
 * The values with the records loaded for a pre-filled walk-in (the scanned visit's visitor and
 * host), shown as chosen until the user picks others or clears them.
 */
export function withLoadedRecords(values: WalkInFormValues, visitor: Visitor | null, host: Host | null): WalkInFormValues {
  return { ...values, existingVisitor: values.existingVisitor ?? visitor, host: values.host ?? host }
}

/** A new host brings their department along (§10 "department default from host"). */
export function withWalkInHost(values: WalkInFormValues, host: Host | null): WalkInFormValues {
  if (!host) return { ...values, host: null }
  return { ...values, host, departmentId: host.department?.id ?? '', departmentChosen: false }
}

/** A department picked in the field is a choice of its own (see `departmentChosen`). */
export function withWalkInDepartment(values: WalkInFormValues, departmentId: string): WalkInFormValues {
  return { ...values, departmentId, departmentChosen: true }
}

export const WALK_IN_MESSAGES = lazyTexts({
  host: () => t('walkIn.validation.host'),
  purpose: () => t('walkIn.validation.purpose'),
  expectedEndMissing: () => t('walkIn.validation.expectedEndMissing'),
  expectedEndPast: () => t('walkIn.validation.expectedEndPast'),
  expectedEndTooLate: () => t('walkIn.validation.expectedEndTooLate'),
  reason: () => t('walkIn.validation.reason'),
  reasonNote: () => t('walkIn.validation.reasonNote'),
})

export function validateWalkIn(values: WalkInFormValues, now: number, timeZone: string): FormErrors<WalkInField> {
  const errors: FormErrors<WalkInField> = {}
  if (!values.existingVisitor) Object.assign(errors, validateVisitorContact(values))
  if (!values.host) errors.host = WALK_IN_MESSAGES.host

  const purpose = values.purpose.trim()
  if (isBlankText(purpose)) errors.purpose = WALK_IN_MESSAGES.purpose
  else if (purpose.length > PURPOSE_MAX_LENGTH) errors.purpose = maxLengthMessage(PURPOSE_MAX_LENGTH)

  const expectedEnd = walkInExpectedEnd(values, now, timeZone)
  if (!expectedEnd) errors.expectedEnd = WALK_IN_MESSAGES.expectedEndMissing
  else {
    const end = Date.parse(expectedEnd)
    if (end <= now) errors.expectedEnd = WALK_IN_MESSAGES.expectedEndPast
    else if (end - now > MAX_VISIT_DURATION_MS) errors.expectedEnd = WALK_IN_MESSAGES.expectedEndTooLate
  }

  if (!values.reason) errors.reason = WALK_IN_MESSAGES.reason
  const note = values.reasonNote.trim()
  if (values.reason === 'OTHER' && isBlankText(note)) errors.reasonNote = WALK_IN_MESSAGES.reasonNote
  else if (note.length > REASON_MAX_LENGTH) errors.reasonNote = maxLengthMessage(REASON_MAX_LENGTH)
  return errors
}

/**
 * The request body; call after `validateWalkIn` passed with the same `now`, with the
 * department the field shows (`inviteDepartmentChoice`). A department only taken over from the
 * host is left out, so the server applies the host's default (B24-23, also if it was
 * deactivated meanwhile); one chosen on purpose is always sent. The note is sent only for
 * OTHER, the reason it explains.
 */
export function toWalkInCreate(values: WalkInFormValues, now: number, timeZone: string, areas: AreaSelection | null = null): WalkInCreate {
  const expectedEnd = walkInExpectedEnd(values, now, timeZone)
  if (!values.host || !expectedEnd || !values.reason) throw new Error('toWalkInCreate needs a validated form')
  const sendDepartment = values.departmentChosen || values.departmentId !== values.host.department?.id
  const departmentId = sendDepartment ? values.departmentId : ''
  const note = values.reasonNote.trim()
  return {
    ...(values.existingVisitor ? { visitor_id: values.existingVisitor.id } : { visitor: toVisitorInput(values) }),
    host_id: values.host.id,
    ...(departmentId ? { department_id: departmentId } : {}),
    purpose: values.purpose.trim(),
    expected_end: expectedEnd,
    reason: values.reason,
    ...(values.reason === 'OTHER' && note ? { reason_note: note } : {}),
    // Phase 16: only while the field is shown, as it shows them (the department's floor until changed).
    ...(areas ? { access_areas: toAreasInput(areas) } : {}),
  }
}

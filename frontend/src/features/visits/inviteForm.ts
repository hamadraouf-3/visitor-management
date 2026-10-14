import { hasRole } from '../../auth/roles'
import { i18n } from '../../i18n'
import { lazyTexts } from '../../i18n/lazyTexts'
import type { DepartmentRef, Host, Me, VisitCreate, Visitor } from '../../types/api'
import { addMinutesUtc, nextHalfHourUtc, type DateInput } from '../../utils/datetime'
import { maxLengthMessage, type FormErrors } from '../../utils/forms'
import { isBlankText } from '../../utils/text'
import {
  EMPTY_VISITOR_CONTACT,
  toVisitorInput,
  validateVisitorContact,
  type VisitorContactValues,
} from '../visitors/visitorFields'
import { DEFAULT_DURATION_MINUTES, endForNewStart, validateSchedule } from './schedule'

export const PURPOSE_MAX_LENGTH = 500

export interface InviteFormValues extends VisitorContactValues {
  /**
   * An existing visitor (picked in the typeahead, or given by "Invite again"); the contact
   * fields are then unused.
   */
  existingVisitor: Visitor | null
  host: Host | null
  /** The chosen department; '' = none chosen (see `inviteDepartmentChoice`). */
  departmentId: string
  /** UTC ISO instants (the inputs show company wall time). */
  start: string | null
  end: string | null
  purpose: string
  sendInvitation: boolean
}

export type InviteField = 'existingVisitor' | keyof VisitorContactValues | 'host' | 'department' | 'start' | 'end' | 'purpose'

/** How the visitor gets their pass: the invitation email, or the host shares the one-time pass link. */
export type PassDelivery = 'email' | 'share'

const t = i18n.getFixedT(null, 'visits')

export const PASS_DELIVERY_LABELS: Record<PassDelivery, string> = lazyTexts({
  email: () => t('invite.deliveryEmail'),
  share: () => t('invite.deliveryShare'),
})

export function passDelivery(values: Pick<InviteFormValues, 'sendInvitation'>): PassDelivery {
  return values.sendInvitation ? 'email' : 'share'
}

/** The messages of the pass-delivery rule, in the UI language when read. */
export const INVITE_MESSAGES = lazyTexts({
  emailRequiredForInvitation: () => t('invite.emailRequiredForInvitation', { share: PASS_DELIVERY_LABELS.share }),
  existingVisitorWithoutEmail: () => t('invite.existingVisitorWithoutEmail', { share: PASS_DELIVERY_LABELS.share }),
  hostRequired: () => t('invite.hostRequired'),
  purposeRequired: () => t('invite.purposeRequired'),
})

/**
 * Whether the signed-in user may invite on behalf of another host (§7.5, phase 10 shared contract A,
 * the user's request of 2026-10-08: "every employee can only make an invitation in their own name").
 * Only an administrator may; everyone else is the host of the visits they create, and the server
 * refuses another `host_id` (422 `host_must_be_self`). Reception's walk-ins still name any host.
 */
export function canChooseHost(user: Pick<Me['user'], 'roles'>): boolean {
  return hasRole(user.roles, 'SYSTEM_ADMIN')
}

/** The signed-in user as a host option (D-02: the default host is the inviting employee). */
export function hostFromMe(user: Me['user']): Host {
  return { id: user.id, full_name: user.full_name, phone: user.phone, department: user.department }
}

/**
 * Defaults (§10 Invite visitor form): host = me (the only host a non-administrator may name, see
 * `canChooseHost`), department = my department, start = the next half hour in the company
 * timezone, end = start + 1 h, send invitation = on. `visitor` preselects a returning visitor
 * ("Invite again" from the visitor's profile).
 */
export function initialInviteValues(me: Me, now: DateInput = Date.now(), visitor: Visitor | null = null): InviteFormValues {
  const start = nextHalfHourUtc(me.company.timezone, now)
  return {
    ...EMPTY_VISITOR_CONTACT,
    existingVisitor: visitor,
    host: hostFromMe(me.user),
    departmentId: me.user.department?.id ?? '',
    start,
    end: addMinutesUtc(start, DEFAULT_DURATION_MINUTES),
    purpose: '',
    sendInvitation: true,
  }
}

export interface InviteDepartmentChoice {
  /** The department the field shows ('' = none). */
  value: string
  /**
   * Whether "No department" can be offered. On create, a missing `department_id` makes the
   * server use the host's department (B24-23) and the contract has no way to ask for none,
   * so "No department" is only offered when the host has no active department.
   */
  allowNone: boolean
  /** The host's department to list while the active departments load (afterwards they list it if it is active). */
  pending: DepartmentRef | null
}

/**
 * The department field of a new visit: the invite form and reception's walk-in form (both are
 * created with the same rule, B24-23). `activeIds` are the active departments, or undefined
 * while they load. A host's department that turns out to be inactive is not the
 * default (the server would refuse it): the field then shows "No department", which is also
 * what the server applies (B24-23).
 */
export function inviteDepartmentChoice(
  values: Pick<InviteFormValues, 'host' | 'departmentId'>,
  activeIds: ReadonlySet<string> | undefined,
): InviteDepartmentChoice {
  const hostDepartment = values.host?.department ?? null
  const isActive = (id: string) => (activeIds ? activeIds.has(id) : true)
  const hostHasActiveDepartment = hostDepartment !== null && isActive(hostDepartment.id)
  const chosen = values.departmentId && isActive(values.departmentId) ? values.departmentId : ''
  return {
    // Without "No department" on offer, nothing chosen means the host's department (what the server applies).
    value: chosen || (hostHasActiveDepartment ? hostDepartment.id : ''),
    allowNone: !hostHasActiveDepartment,
    pending: activeIds ? null : hostDepartment,
  }
}

/** A new host brings their department along (the department defaults to the host's). */
export function withHost(values: InviteFormValues, host: Host | null): InviteFormValues {
  if (!host) return { ...values, host: null }
  return { ...values, host, departmentId: host.department?.id ?? '' }
}

/** A new start keeps the visit's length (see `endForNewStart`). */
export function withStart(values: InviteFormValues, start: string | null): InviteFormValues {
  return { ...values, start, end: endForNewStart(values, start) }
}

export function validateInvite(values: InviteFormValues, now: number): FormErrors<InviteField> {
  const errors: FormErrors<InviteField> = {}

  if (values.existingVisitor) {
    if (values.sendInvitation && !values.existingVisitor.email) errors.existingVisitor = INVITE_MESSAGES.existingVisitorWithoutEmail
  } else {
    Object.assign(
      errors,
      validateVisitorContact(values, { emailRequiredMessage: values.sendInvitation ? INVITE_MESSAGES.emailRequiredForInvitation : undefined }),
    )
  }

  if (!values.host) errors.host = INVITE_MESSAGES.hostRequired
  Object.assign(errors, validateSchedule(values, { now }))

  const purpose = values.purpose.trim()
  if (isBlankText(purpose)) errors.purpose = INVITE_MESSAGES.purposeRequired
  else if (purpose.length > PURPOSE_MAX_LENGTH) errors.purpose = maxLengthMessage(PURPOSE_MAX_LENGTH)
  return errors
}

/**
 * The request body. Start and end are already UTC instants (`…Z`, timezone-aware as §3.2-7
 * requires): the date-time fields convert the company wall time the user typed, so the result
 * does not depend on the browser's timezone. Call only after `validateInvite` passed, with the
 * department the field shows (`inviteDepartmentChoice`).
 *
 * The host's own department is left out: the server then applies it as the default (B24-23),
 * or none if it was deactivated meanwhile, instead of refusing the visit for a department
 * the user never chose.
 */
export function toVisitCreate(values: InviteFormValues): VisitCreate {
  if (!values.host || !values.start || !values.end) throw new Error('toVisitCreate needs a validated form')
  const departmentId = values.departmentId !== values.host.department?.id ? values.departmentId : ''
  return {
    ...(values.existingVisitor ? { visitor_id: values.existingVisitor.id } : { visitor: toVisitorInput(values) }),
    host_id: values.host.id,
    ...(departmentId ? { department_id: departmentId } : {}),
    purpose: values.purpose.trim(),
    scheduled_start: values.start,
    scheduled_end: values.end,
    send_invitation: values.sendInvitation,
  }
}

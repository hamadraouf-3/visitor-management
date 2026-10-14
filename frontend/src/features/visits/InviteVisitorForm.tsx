import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useActiveDepartments } from '../../api/queries'
import { Alert } from '../../components/ui/Alert'
import { Button, ButtonLink } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Field } from '../../components/ui/Field'
import { Input } from '../../components/ui/Input'
import { RadioGroup } from '../../components/ui/RadioGroup'
import { Textarea } from '../../components/ui/Textarea'
import { useFormErrors } from '../../hooks/useFormErrors'
import { paths } from '../../paths'
import type { Me, VisitCreate, VisitCreateResult, Visitor } from '../../types/api'
import type { FieldErrorCodes, ServerFieldPaths } from '../../utils/forms'
import { focusFirstControl } from '../../utils/focus'
import { characterCountLabel } from '../../utils/text'
import { VisitorSourceFields } from '../visitors/VisitorSourceFields'
import {
  canChooseHost,
  hostFromMe,
  initialInviteValues,
  inviteDepartmentChoice,
  PASS_DELIVERY_LABELS,
  passDelivery,
  PURPOSE_MAX_LENGTH,
  toVisitCreate,
  validateInvite,
  withHost,
  withStart,
  type InviteField,
  type InviteFormValues,
  type PassDelivery,
} from './inviteForm'
import { DepartmentSelect, HostPicker } from './pickers'
import { useCreateVisit } from './queries'
import { ScheduleFields } from './ScheduleFields'

/** Where the server reports each field (§8.2 `details.fields`). */
const SERVER_FIELDS: ServerFieldPaths<InviteField> = {
  existingVisitor: ['visitor_id', 'visitor'],
  fullName: 'visitor.full_name',
  email: 'visitor.email',
  phone: 'visitor.phone',
  companyName: 'visitor.company_name',
  host: 'host_id',
  department: 'department_id',
  start: 'scheduled_start',
  end: 'scheduled_end',
  purpose: 'purpose',
}

export interface InviteVisitorFormProps {
  me: Me
  /** The visit was created (the result carries the one-time pass link); `request` is what was sent. */
  onCreated: (result: VisitCreateResult, request: VisitCreate) => void
  /** Focus the first field on mount ("Invite another visitor" replaced the focused success view). */
  focusOnMount?: boolean
  /** A returning visitor to start with ("Invite again" on the visitor's profile). */
  initialVisitor?: Visitor | null
}

/**
 * Invite visitor (§10): a returning visitor from the typeahead or a new visitor's details,
 * how the visitor gets their pass (by email, the default, or shared by the host), host,
 * department (default: the host's), start and end in the company timezone, and purpose. Only
 * optional fields are marked.
 *
 * The host is the signed-in user, shown read-only, unless they are an administrator, who may pick
 * any active host (default: themselves; §7.5, `canChooseHost`).
 */
export function InviteVisitorForm({ me, onCreated, focusOnMount = false, initialVisitor = null }: InviteVisitorFormProps) {
  const { t } = useTranslation('visits')
  const timeZone = me.company.timezone
  const mutation = useCreateVisit()
  const departments = useActiveDepartments()
  const choosesHost = canChooseHost(me.user)
  const [values, setValues] = useState<InviteFormValues>(() => initialInviteValues(me, Date.now(), initialVisitor))
  // Field-level refusals of POST /visits: a returning visitor without an address, and an address
  // already registered to a visitor of another name (B57-01, whose message says what to check).
  const visitorField = values.existingVisitor ? 'existingVisitor' : 'email'
  const codes: FieldErrorCodes<InviteField> = { VISITOR_EMAIL_REQUIRED: visitorField, VISITOR_EXISTS: visitorField }
  const form = useFormErrors(mutation.error, { fields: SERVER_FIELDS, codes })
  const firstFieldId = form.field('existingVisitor').id

  const activeDepartmentIds = departments.data
    ? new Set(departments.data.filter((department) => department.is_active).map((department) => department.id))
    : undefined
  const department = inviteDepartmentChoice(values, activeDepartmentIds)

  useEffect(() => {
    if (focusOnMount) focusFirstControl([firstFieldId])
  }, [focusOnMount, firstFieldId])

  const set = <K extends keyof InviteFormValues>(key: K, value: InviteFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }))

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateInvite(values, Date.now()))) return
    // Whoever is not an administrator invites as themselves: their own id, whatever the form holds.
    const host = choosesHost ? values.host : hostFromMe(me.user)
    const body = toVisitCreate({ ...values, host, departmentId: department.value })
    mutation.mutate(body, { onSuccess: (result) => onCreated(result, body) })
  }

  const send = values.sendInvitation

  return (
    <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-6">
      {form.formError && <Alert tone="danger">{form.formError}</Alert>}

      <Card title={t('invite.visitorCard.title')}>
        <div className="flex flex-col gap-4">
          <VisitorSourceFields
            visitor={values.existingVisitor}
            onVisitorChange={(visitor) => set('existingVisitor', visitor)}
            contact={values}
            onContactChange={(key, value) => set(key, value)}
            field={form.field}
            emailRequired={send}
            error={mutation.error}
            onRegisteredVisitor={(visitor) => {
              mutation.reset()
              set('existingVisitor', visitor)
            }}
          />

          {/* Decides whether Email is needed, so it sits right under it, not at the end of the form.
              Each option is named by what it does (no description, decision 3); a segmented choice, as
              every quick pick of the app (walk-in stay and reason, the default language). The hairline
              is the wrapper's: on the fieldset it would run through the legend. */}
          <div className="border-t border-border-subtle pt-4">
            <RadioGroup
              variant="segmented"
              label={t('invite.deliveryLabel')}
              value={passDelivery(values)}
              onValueChange={(delivery: PassDelivery) => set('sendInvitation', delivery === 'email')}
              options={[
                { value: 'email', label: PASS_DELIVERY_LABELS.email },
                { value: 'share', label: PASS_DELIVERY_LABELS.share },
              ]}
            />
          </div>
        </div>
      </Card>

      <Card title={t('invite.visitCard.title')}>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {choosesHost ? (
              <Field label={t('invite.host')} required {...form.field('host')}>
                <HostPicker value={values.host} onChange={(host) => setValues((current) => withHost(current, host))} />
              </Field>
            ) : (
              // The inviting employee is the host (data, not a choice): read-only, so it is still read
              // with its label and can carry the server's refusal of another host.
              <Field label={t('invite.host')} {...form.field('host')}>
                <Input readOnly autoComplete="off" value={me.user.full_name} className="read-only:bg-surface-muted" />
              </Field>
            )}
            <Field label={t('invite.department')} optional {...form.field('department')}>
              <DepartmentSelect
                value={department.value}
                onChange={(departmentId) => set('departmentId', departmentId)}
                current={department.pending}
                allowNone={department.allowNone}
              />
            </Field>
          </div>
          <ScheduleFields
            timeZone={timeZone}
            values={values}
            onStartChange={(start) => setValues((current) => withStart(current, start))}
            onEndChange={(end) => set('end', end)}
            startField={form.field('start')}
            endField={form.field('end')}
          />
          <Field label={t('invite.purpose')} required hint={characterCountLabel(values.purpose, PURPOSE_MAX_LENGTH)} {...form.field('purpose')}>
            <Textarea rows={3} value={values.purpose} onChange={(event) => set('purpose', event.target.value)} />
          </Field>
        </div>
      </Card>

      {/* Reading order is focus order in every layout (WCAG 2.4.3), as in dialog footers: the
          safe choice first, the primary action last (rightmost on wide screens). */}
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <ButtonLink to={paths.myVisits} variant="secondary">
          {t('invite.cancel')}
        </ButtonLink>
        <Button type="submit" loading={mutation.isPending}>
          {send ? t('invite.submitSend') : t('invite.submitCreate')}
        </Button>
      </div>
    </form>
  )
}

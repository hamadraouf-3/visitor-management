import { DoorOpen, Eraser, LogIn } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useActiveDepartments, useCompanySettings, useHostById } from '../../api/queries'
import { useAuth } from '../../auth/useAuth'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { DateTimeField } from '../../components/ui/DateTimeField'
import { EmptyState } from '../../components/ui/EmptyState'
import { Field } from '../../components/ui/Field'
import { PhoneLink } from '../../components/ui/PhoneLink'
import { RadioGroup } from '../../components/ui/RadioGroup'
import { PageSpinner } from '../../components/ui/Spinner'
import { StickyActionBar } from '../../components/ui/StickyActionBar'
import { Textarea } from '../../components/ui/Textarea'
import { useFormErrors } from '../../hooks/useFormErrors'
import { useNow } from '../../hooks/useNow'
import type { DepartmentRef, Visit, WalkInReason } from '../../types/api'
import { momentOnDay, type MomentOnDay } from '../../utils/datetime'
import type { FieldErrorCodes, ServerFieldPaths } from '../../utils/forms'
import { characterCountLabel } from '../../utils/text'
import { AccessAreasPicker } from '../accessAreas/AccessAreasPicker'
import { useFormAccessAreas } from '../accessAreas/useFormAccessAreas'
import { useVisitor } from '../visitors/queries'
import { VisitorSourceFields } from '../visitors/VisitorSourceFields'
import { inviteDepartmentChoice, PURPOSE_MAX_LENGTH } from '../visits/inviteForm'
import { DepartmentSelect, HostPicker } from '../visits/pickers'
import { REASON_MAX_LENGTH } from './checkOutForms'
import { useCreateWalkIn } from './queries'
import {
  hasContactDetails,
  initialWalkInValues,
  toWalkInCreate,
  validateWalkIn,
  WALK_IN_REASON_OPTIONS,
  walkInExpectedEnd,
  walkInStayOptions,
  withLoadedRecords,
  withWalkInDepartment,
  withWalkInHost,
  withWalkInStay,
  type HostReference,
  type WalkInField,
  type WalkInFormValues,
  type WalkInStay,
} from './walkInForm'

/** Where the server reports each field (§8.2 `details.fields`). */
const SERVER_FIELDS: ServerFieldPaths<WalkInField> = {
  existingVisitor: ['visitor_id', 'visitor'],
  fullName: 'visitor.full_name',
  email: 'visitor.email',
  phone: 'visitor.phone',
  companyName: 'visitor.company_name',
  host: 'host_id',
  department: 'department_id',
  purpose: 'purpose',
  expectedEnd: 'expected_end',
  reason: 'reason',
  reasonNote: 'reason_note',
  areas: ['access_areas', 'access_areas.floor_ids', 'access_areas.zone_ids'],
}

/**
 * Refusals about one field: an email address registered to a visitor of another name (B57-70).
 * Only a new visitor's details can be refused so; a returning visitor is sent by id.
 */
const SERVER_CODES: FieldErrorCodes<WalkInField> = { VISITOR_EXISTS: 'email' }

/** The walk-in being entered; kept by the reception screen, so switching tabs does not lose it. */
export interface WalkInDraft {
  values: WalkInFormValues
  /** A visitor to load and select (pre-filled from a scanned visit). */
  loadVisitorId: string | null
  /** A host to look up and select (pre-filled from a scanned visit). */
  loadHost: HostReference | null
  /** The pre-filled department, listed while the departments load. */
  prefillDepartment: DepartmentRef | null
}

const NO_PENDING_LOADS = { loadVisitorId: null, loadHost: null, prefillDepartment: null } as const

export interface WalkInPanelProps {
  timeZone: string
  /** null until the tab was first used; the panel starts a fresh walk-in then. */
  draft: WalkInDraft | null
  onDraftChange: (draft: WalkInDraft) => void
  onCreated: (visit: Visit) => void
}

/**
 * Walk-in tab (§10, D-07), built for speed (target < 10 s): lookup first, so a returning
 * visitor needs at most four inputs (visitor, host, purpose, reason); a new visitor needs a
 * name, and the optional company, phone and email wait behind "Add contact details". The host
 * comes with their phone and the department follows the host. How long the visitor stays is a
 * quick pick (default one hour from when the form is sent, company time zone); the date and
 * time fields appear only for "Other…". "Other" as the reason needs a note. On touch screens
 * the actions stay in reach at the bottom of the screen. The visitor is created checked in. Phase 16:
 * «المناطق المسموحة» / "Allowed areas" while the company's tracking is allowed and it has floors, prefilled
 * from the department's floor until reception changes the field, and sent only while shown.
 */
export function WalkInPanel({ timeZone, draft, onDraftChange, onCreated }: WalkInPanelProps) {
  const { t } = useTranslation('reception')
  const { me } = useAuth()
  const [fresh] = useState<WalkInDraft>(() => ({ values: initialWalkInValues(), ...NO_PENDING_LOADS }))
  const now = useNow()
  const [contactOpened, setContactOpened] = useState(false)
  const current = draft ?? fresh
  const mutation = useCreateWalkIn()
  const settings = useCompanySettings()
  const departments = useActiveDepartments()
  const form = useFormErrors(mutation.error, { fields: SERVER_FIELDS, codes: SERVER_CODES })
  // When the visitor leaves if checked in now: «الساعة» before a time only; a stay past midnight names its day.
  const stayHint = (end: MomentOnDay) =>
    end.sameDay ? t('walkIn.stay.hint', { time: end.time }) : t('walkIn.stay.hintOn', { date: end.date, time: end.time })

  // A walk-in pre-filled from a scanned visit knows only the visitor's id: the record is loaded
  // and shown as the chosen visitor until the user picks another one (or clears the form).
  const loadVisitorId = current.loadVisitorId
  const prefilled = useVisitor(loadVisitorId ?? '', loadVisitorId !== null)
  const loadedVisitor = loadVisitorId !== null && prefilled.data?.id === loadVisitorId ? prefilled.data : null
  // The scanned visit's host is looked up for the host record: its own department, which the
  // department field and the request depend on (the visit's department may be another one).
  const loadHost = current.loadHost
  // The visit's host record, which knows the host's own department (not the visit's).
  const hostLookup = useHostById(loadHost && { id: loadHost.id, nameHint: loadHost.full_name })
  const loadedHost = loadHost !== null ? (hostLookup.data ?? null) : null
  // The draft itself while nothing was loaded into it.
  const values =
    (current.values.existingVisitor === null && loadedVisitor) || (current.values.host === null && loadedHost)
      ? withLoadedRecords(current.values, loadedVisitor, loadedHost)
      : current.values
  const loadingVisitor = loadVisitorId !== null && prefilled.isPending
  const visitorLoadFailed = loadVisitorId !== null && prefilled.isError && values.existingVisitor === null
  const loadingHost = loadHost !== null && values.host === null && hostLookup.isPending
  const hostNotFound = loadHost !== null && values.host === null && !hostLookup.isPending

  const activeDepartmentIds = departments.data
    ? new Set(departments.data.filter((department) => department.is_active).map((department) => department.id))
    : undefined
  const department = inviteDepartmentChoice(values, activeDepartmentIds)
  const listedDepartment = department.pending ?? (activeDepartmentIds ? null : current.prefillDepartment)
  const areas = useFormAccessAreas(me, department.value, values.accessAreas)

  const update = (next: WalkInFormValues) =>
    onDraftChange({
      values: next,
      // Once a visitor or a host is shown (loaded or picked), its pending load is done with.
      loadVisitorId: values.existingVisitor !== null || next.existingVisitor !== null ? null : loadVisitorId,
      loadHost: values.host !== null || next.host !== null ? null : loadHost,
      prefillDepartment: current.prefillDepartment,
    })
  const set = <K extends keyof WalkInFormValues>(key: K, value: WalkInFormValues[K]) => update({ ...values, [key]: value })
  const stayOptions = walkInStayOptions(now, timeZone, values.stay)
  const stayEnd = values.stay === 'other' ? null : walkInExpectedEnd(values, now, timeZone)

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // One instant for the check and the request: a quick-pick stay counts from the moment the form is sent.
    const sentAt = Date.now()
    if (!form.validate(validateWalkIn(values, sentAt, timeZone))) return
    mutation.mutate(toWalkInCreate({ ...values, departmentId: department.value }, sentAt, timeZone, areas.shown ? areas.value : null), { onSuccess: onCreated })
  }

  const clear = () => {
    mutation.reset()
    setContactOpened(false)
    onDraftChange({ values: initialWalkInValues(), ...NO_PENDING_LOADS })
  }

  // Settings that cannot be loaded do not block walk-ins: the server refuses them when disabled.
  const walkInsAllowed = settings.data ? settings.data.allow_walk_ins : settings.isError ? true : undefined
  if (walkInsAllowed === undefined) return <PageSpinner label={t('walkIn.loading')} />
  if (!walkInsAllowed) {
    return <EmptyState icon={DoorOpen} title={t('walkIn.disabledTitle')} />
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-6">
      {form.formError && <Alert tone="danger">{form.formError}</Alert>}

      <Card title={t('walkIn.visitorCard.title')}>
        <div className="flex flex-col gap-4">
          {visitorLoadFailed && <Alert tone="warning">{t('walkIn.visitorLoadFailed')}</Alert>}
          <VisitorSourceFields
            visitor={values.existingVisitor}
            onVisitorChange={(visitor) => set('existingVisitor', visitor)}
            contact={values}
            onContactChange={(key, value) => set(key, value)}
            field={form.field}
            pickerHint={loadingVisitor ? t('walkIn.loadingVisitor') : undefined}
            contactDetails={{ open: contactOpened || hasContactDetails(values), onOpen: () => setContactOpened(true) }}
            error={mutation.error}
            onRegisteredVisitor={(visitor) => {
              mutation.reset()
              set('existingVisitor', visitor)
            }}
          />
        </div>
      </Card>

      <Card title={t('walkIn.visitCard.title')}>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label={t('walkIn.host')}
              required
              hint={
                values.host?.phone ? (
                  // On a touch screen the link's tap area reaches 12 px above it, past the field's 6 px gap: the host's
                  // input took the top of it (41 px left). Room above it there keeps the 44 px whole.
                  <span className="inline-block pointer-coarse:pt-2">
                    <PhoneLink phone={values.host.phone} label={t('call', { name: values.host.full_name })} />
                  </span>
                ) : values.host ? (
                  t('walkIn.hostNoPhone')
                ) : loadingHost ? (
                  t('walkIn.loadingHost')
                ) : hostNotFound && loadHost ? (
                  t('walkIn.hostInactive', { name: loadHost.full_name })
                ) : undefined
              }
              {...form.field('host')}
            >
              <HostPicker value={values.host} onChange={(host) => update(withWalkInHost(values, host))} />
            </Field>
            <Field label={t('walkIn.department')} optional {...form.field('department')}>
              <DepartmentSelect
                value={department.value}
                onChange={(departmentId) => update(withWalkInDepartment(values, departmentId))}
                current={listedDepartment}
                allowNone={department.allowNone}
              />
            </Field>
          </div>
          <Field label={t('walkIn.purpose')} required hint={characterCountLabel(values.purpose, PURPOSE_MAX_LENGTH)} {...form.field('purpose')}>
            <Textarea rows={2} value={values.purpose} onChange={(event) => set('purpose', event.target.value)} />
          </Field>
          <RadioGroup<WalkInStay>
            label={t('walkIn.stay.label')}
            variant="segmented"
            size="xl"
            options={stayOptions}
            value={values.stay}
            onValueChange={(stay) => update(withWalkInStay(values, stay, Date.now(), timeZone))}
            hint={stayEnd ? stayHint(momentOnDay(stayEnd, now, timeZone)) : undefined}
            required
            {...(values.stay === 'other' ? {} : form.field('expectedEnd'))}
          />
          {values.stay === 'other' && (
            <DateTimeField
              label={t('walkIn.expectedEnd')}
              value={values.expectedEnd}
              onChange={(expectedEnd) => set('expectedEnd', expectedEnd)}
              timeZone={timeZone}
              readBack
              required
              {...form.field('expectedEnd')}
            />
          )}
          <RadioGroup<WalkInReason>
            label={t('walkIn.reason')}
            variant="segmented"
            size="xl"
            layout="grid"
            options={WALK_IN_REASON_OPTIONS}
            value={values.reason}
            onValueChange={(reason) => set('reason', reason)}
            required
            {...form.field('reason')}
          />
          {values.reason === 'OTHER' && (
            <Field
              label={t('walkIn.reasonDetails')}
              required
              hint={characterCountLabel(values.reasonNote, REASON_MAX_LENGTH)}
              {...form.field('reasonNote')}
            >
              <Textarea rows={2} value={values.reasonNote} onChange={(event) => set('reasonNote', event.target.value)} />
            </Field>
          )}
          {areas.shown && areas.options && (
            <div className="border-t border-border-subtle pt-4">
              <AccessAreasPicker options={areas.options} value={areas.value} onChange={(next) => set('accessAreas', next)} optional {...form.field('areas')} />
            </div>
          )}
        </div>
      </Card>

      {/*
       * The safe action first, the primary last: reading, visual and Tab order agree. "Clear
       * form" is a quiet action at the far left, away from the primary on the right. The bar
       * stays at the bottom of the screen, edge to edge, while the form scrolls (on a tablet, a
       * phone and a 900 px high desktop alike), so the check-in is always one tap away; when
       * the form fits the screen it simply sits under it.
       */}
      <StickyActionBar className="flex flex-wrap items-center justify-between gap-3">
        {/* On the narrowest screens (320 px, or 400 % zoom) both buttons fit one row without the eraser icon. */}
        <Button
          variant="ghost"
          icon={<Eraser aria-hidden="true" className="max-xs:hidden" />}
          onClick={clear}
          disabled={mutation.isPending}
          className="-ms-3"
        >
          {t('walkIn.clear')}
        </Button>
        {/* Should the row still be too narrow (larger text), the primary wraps under it, still at the inline end. */}
        <Button type="submit" size="lg" icon={<LogIn aria-hidden="true" className="mirror-rtl" />} loading={mutation.isPending} className="ms-auto">
          {t('walkIn.submit')}
        </Button>
      </StickyActionBar>
    </form>
  )
}

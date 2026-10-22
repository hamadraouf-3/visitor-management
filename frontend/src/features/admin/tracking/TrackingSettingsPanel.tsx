import { Plus, Save, Undo2, X } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { getErrorMessage } from '../../../api/client'
import { Alert } from '../../../components/ui/Alert'
import { ApiErrorMessage } from '../../../components/ui/ApiErrorMessage'
import { Badge } from '../../../components/ui/Badge'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { Dialog } from '../../../components/ui/Dialog'
import { Field } from '../../../components/ui/Field'
import { Input } from '../../../components/ui/Input'
import { LoadErrorAlert } from '../../../components/ui/LoadErrorAlert'
import { PageSpinner } from '../../../components/ui/Spinner'
import { Switch } from '../../../components/ui/Switch'
import { useToast } from '../../../components/ui/toastContext'
import { EmailText } from '../../../components/ui/EmailText'
import { useFormErrors } from '../../../hooks/useFormErrors'
import { FOCUS_ROW_ATTRIBUTE, useListFocusRecovery } from '../../../hooks/useListFocusRecovery'
import { useStableId } from '../../../hooks/useStableId'
import type { TrackingSettings, TrackingSettingsUpdate } from '../../../types/api'
import { formatDateTime } from '../../../utils/datetime'
import { formatCount } from '../../../utils/number'
import { FactList } from '../../visits/FactList'
import { SimulatedBadge } from '../../journey/JourneyBadges'
import { useAuth } from '../../../auth/useAuth'
import { useTrackingSettings, useUpdateTrackingSettings } from './queries'
import { TrackingKeysCard } from './TrackingKeys'
import {
  ALERT_EMAIL_PATHS,
  alertEmailsDirty,
  MAX_ALERT_EMAILS,
  THRESHOLD_FIELDS,
  thresholdsDirty,
  thresholdValues,
  toAlertEmailsUpdate,
  toThresholdUpdate,
  validateAlertEmail,
  validateThresholds,
  withAlertEmail,
  type ThresholdField,
  type ThresholdValues,
} from './trackingForms'

/**
 * The switch (Phase 15): on at once; off after one line, since it ends every running tracking of the
 * company. While the platform owner has not allowed tracking it cannot be turned on, and says so beside it
 * as a short state. The deployment's provider is a fact under it: «محاكاة» / "Simulated" for the simulator,
 * «لا يوجد» / "None" where there is no provider (the company can still prepare its places and cameras).
 */
function TrackingSwitchCard({ settings }: { settings: TrackingSettings }) {
  const { t } = useTranslation('admin')
  const toast = useToast()
  const update = useUpdateTrackingSettings()
  const [confirmingOff, setConfirmingOff] = useState(false)
  const stateId = useStableId('tracking-allowed')
  const blocked = !settings.allowed && !settings.enabled
  // Cancel, Escape, the close button and the backdrop all leave the same way: the refusal is cleared.
  const closeConfirm = () => {
    setConfirmingOff(false)
    update.reset()
  }

  const apply = (enabled: boolean) =>
    update.mutate(
      { enabled },
      {
        onSuccess: () => {
          setConfirmingOff(false)
          toast.show({ tone: 'success', title: enabled ? t('tracking.settings.turnedOn') : t('tracking.settings.turnedOff') })
        },
        onError: (error) => {
          if (!enabled) return
          toast.show({ tone: 'danger', title: t('tracking.settings.turnOnFailed'), description: getErrorMessage(error) })
        },
      },
    )

  return (
    <Card title={t('tracking.settings.switchTitle')}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Switch
            label={t('tracking.settings.switch')}
            checked={settings.enabled}
            disabled={blocked}
            loading={update.isPending && !confirmingOff}
            aria-describedby={blocked ? stateId : undefined}
            onCheckedChange={(next) => (next ? apply(true) : setConfirmingOff(true))}
          />
          {!settings.allowed && (
            <span id={stateId} data-tracking-not-allowed="">
              <Badge tone="neutral">{t('tracking.settings.notAllowed')}</Badge>
            </span>
          )}
        </div>
        <FactList
          columns={1}
          items={[
            {
              term: t('tracking.settings.provider'),
              description:
                settings.provider === 'simulator' ? (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    {t('tracking.settings.providers.simulator')}
                    <SimulatedBadge />
                  </span>
                ) : (
                  t('tracking.settings.providers.disabled')
                ),
            },
          ]}
        />
      </div>
      <Dialog
        open={confirmingOff}
        role="alertdialog"
        onClose={closeConfirm}
        dismissible={!update.isPending}
        title={t('tracking.settings.turnOffTitle')}
        description={t('tracking.settings.turnOffDescription')}
        footer={
          <>
            <Button variant="secondary" onClick={closeConfirm} disabled={update.isPending} focusableWhenDisabled>
              {t('tracking.settings.keepOn')}
            </Button>
            <Button variant="danger" loading={update.isPending} onClick={() => apply(false)}>
              {t('tracking.settings.turnOff')}
            </Button>
          </>
        }
      >
        {update.isError ? (
          <Alert tone="danger">
            <ApiErrorMessage error={update.error} outsideForm />
          </Alert>
        ) : undefined}
      </Dialog>
    </Card>
  )
}

interface NumberInputProps {
  value: string
  onChange: (event: { target: { value: string } }) => void
  inputMode: 'numeric' | 'decimal'
}

/** A narrow number field, typed left to right. */
function NumberInput(props: NumberInputProps) {
  return <Input dir="ltr" autoComplete="off" className="max-w-28" {...props} />
}

/**
 * A number with its unit shown beside it (the company settings' minutes, F10), and read with it: the unit
 * describes the field, so a screen reader says "15, minutes" (F15-34).
 */
function NumberWithUnit({ unit, ...props }: NumberInputProps & { unit: string }) {
  const unitId = useStableId('unit')
  return (
    <span className="flex items-center gap-2">
      <Input dir="ltr" autoComplete="off" className="max-w-28" aria-describedby={unitId} {...props} />
      <span id={unitId} className="text-sm text-fg-muted">
        {unit}
      </span>
    </span>
  )
}

interface ThresholdsCardProps {
  settings: TrackingSettings
  draft: ThresholdValues | null
  onDraftChange: (draft: ThresholdValues | null) => void
}

/**
 * The thresholds: the confidence below which nothing counts as confirmed (empty: nothing does; the value
 * must come from an evaluation on the site's footage, as the docs say), after how many minutes a floor is
 * no longer recent, and how long journeys are kept. Saved together; only what changed is sent.
 */
function ThresholdsCard({ settings, draft, onDraftChange }: ThresholdsCardProps) {
  const { t } = useTranslation('admin')
  const toast = useToast()
  const save = useUpdateTrackingSettings()
  const values = draft ?? thresholdValues(settings)
  const form = useFormErrors(save.error, { fields: THRESHOLD_FIELDS })
  const formId = useStableId('tracking-thresholds')
  const dirty = thresholdsDirty(settings, values)
  const set = (key: ThresholdField) => ({
    value: values[key],
    onChange: (event: { target: { value: string } }) => {
      const next = { ...values, [key]: event.target.value }
      onDraftChange(next)
      if (form.attempted) form.refresh(validateThresholds(next))
    },
  })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateThresholds(values))) return
    const body = toThresholdUpdate(settings, values)
    if (!body) {
      onDraftChange(null)
      return
    }
    save.mutate(body, {
      onSuccess: () => {
        onDraftChange(null)
        toast.show({ tone: 'success', title: t('tracking.settings.saved') })
      },
    })
  }

  return (
    <Card title={t('tracking.settings.thresholdsTitle')}>
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-5">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-3">
          <Field label={t('tracking.settings.minConfidence')} optional {...form.field('minConfidence')}>
            {/* The percentage is in the label ("Minimum confidence (%)"): 0.8 is not 80 %. */}
            <NumberInput inputMode="decimal" {...set('minConfidence')} />
          </Field>
          <Field label={t('tracking.settings.staleAfter')} {...form.field('staleMinutes')}>
            <NumberWithUnit unit={t('tracking.settings.minutesUnit')} inputMode="numeric" {...set('staleMinutes')} />
          </Field>
          <Field label={t('tracking.settings.retention')} {...form.field('retentionDays')}>
            <NumberWithUnit unit={t('tracking.settings.daysUnit')} inputMode="numeric" {...set('retentionDays')} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:justify-end">
          <p role="status" className="basis-full text-sm text-fg-muted sm:me-auto sm:basis-auto">
            {dirty ? t('settings.status.unsaved') : t('settings.status.saved')}
          </p>
          <Button variant="secondary" icon={<Undo2 aria-hidden="true" />} disabled={!dirty || save.isPending} focusableWhenDisabled onClick={() => onDraftChange(null)}>
            {t('settings.discard')}
          </Button>
          <Button type="submit" icon={<Save aria-hidden="true" />} loading={save.isPending} disabled={!dirty} focusableWhenDisabled>
            {t('settings.save')}
          </Button>
        </div>
      </form>
    </Card>
  )
}

interface AreaAlertsCardProps {
  settings: TrackingSettings
  /** The alert e-mails being edited (kept by the page, as the thresholds); null: the saved ones. */
  draft: string[] | null
  onDraftChange: (draft: string[] | null) => void
}

/**
 * The area alerts (Phase 16), «تنبيهات التتبّع» / "Tracking alerts": whether they are raised and whether the
 * visit's host is e-mailed, two switches that take effect at once; and «بريد التنبيهات» / "Alert emails", up
 * to five more addresses an alert is e-mailed to, added and removed here and saved together with Save (only
 * when the list changed). An address is checked when it is added (a valid address, not listed yet, five at
 * most), lower case as the server keeps it; the server's refusal of one is said at the address field. When an
 * address is removed the focus goes on to the next one's remove button, else to the address field.
 */
function AreaAlertsCard({ settings, draft, onDraftChange }: AreaAlertsCardProps) {
  const { t } = useTranslation('admin')
  const toast = useToast()
  const switches = useUpdateTrackingSettings()
  const save = useUpdateTrackingSettings()
  const [text, setText] = useState('')
  const emails = draft ?? settings.alert_emails
  const form = useFormErrors<'newEmail'>(save.error, { fields: { newEmail: ALERT_EMAIL_PATHS } })
  const formId = useStableId('alert-emails')
  const fullId = useStableId('alert-emails-full')
  const listRef = useRef<HTMLUListElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const recoverFocus = useListFocusRecovery({ list: listRef, fallback: inputRef, version: emails })
  const dirty = alertEmailsDirty(settings, draft)
  const full = emails.length >= MAX_ALERT_EMAILS
  // Which switch is being saved: the other one stays usable.
  const saving = (field: keyof TrackingSettingsUpdate) => switches.isPending && switches.variables !== undefined && field in switches.variables

  const toggle = (body: TrackingSettingsUpdate) =>
    switches.mutate(body, {
      onSuccess: () => toast.show({ tone: 'success', title: t('tracking.settings.saved') }),
      onError: (error) => toast.show({ tone: 'danger', title: t('tracking.alerts.saveFailed'), description: getErrorMessage(error) }),
    })

  const add = () => {
    if (!form.validate({ newEmail: validateAlertEmail(text, emails) })) return
    const next = withAlertEmail(emails, text)
    // The fifth address disables the field that may hold the focus (added with Enter): "Add", which stays
    // focusable and says why it waits, takes it first (F16-46).
    if (next.length >= MAX_ALERT_EMAILS) addRef.current?.focus()
    onDraftChange(next)
    setText('')
  }

  const remove = (email: string) => {
    recoverFocus(email)
    onDraftChange(emails.filter((other) => other !== email))
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    form.validate({})
    const body = toAlertEmailsUpdate(settings, draft)
    if (!body) {
      onDraftChange(null)
      return
    }
    save.mutate(body, {
      onSuccess: () => {
        onDraftChange(null)
        toast.show({ tone: 'success', title: t('tracking.settings.saved') })
      },
    })
  }

  return (
    <Card title={t('tracking.alerts.title')}>
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Switch
            label={t('tracking.alerts.areaAlerts')}
            checked={settings.area_alerts_enabled}
            loading={saving('area_alerts_enabled')}
            onCheckedChange={(next) => toggle({ area_alerts_enabled: next })}
          />
          <Switch
            label={t('tracking.alerts.notifyHost')}
            checked={settings.alert_notify_host}
            loading={saving('alert_notify_host')}
            onCheckedChange={(next) => toggle({ alert_notify_host: next })}
          />
        </div>

        <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-4 border-t border-border-subtle pt-5">
          {form.formError && <Alert tone="danger">{form.formError}</Alert>}
          <h3 className="text-sm font-semibold text-fg">{t('tracking.alerts.emails')}</h3>
          {emails.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('tracking.alerts.none')}</p>
          ) : (
            <ul ref={listRef} aria-label={t('tracking.alerts.emails')} className="flex flex-col divide-y divide-border-subtle">
              {emails.map((email) => (
                <li key={email} {...{ [FOCUS_ROW_ATTRIBUTE]: email }} className="flex min-h-11 items-center gap-3 py-1">
                  {/* The address is isolated left to right inside a box of the page's direction: at the start of the row in Arabic too. */}
                  <span className="min-w-0 flex-1 text-sm text-fg">
                    <EmailText address={email} />
                  </span>
                  <button
                    type="button"
                    onClick={() => remove(email)}
                    className="flex size-11 shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-surface-muted hover:text-fg"
                  >
                    <X aria-hidden="true" className="size-5" />
                    <span className="sr-only">{t('tracking.alerts.remove', { email })}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <Field label={t('tracking.alerts.newEmail')} className="min-w-0 sm:max-w-sm sm:flex-1" {...form.field('newEmail')}>
              <Input
                ref={inputRef}
                type="email"
                inputMode="email"
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                value={text}
                disabled={full}
                aria-describedby={full ? fullId : undefined}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  // Enter adds the address; Save sends the list.
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  add()
                }}
              />
            </Field>
            {/* Level with the field (its label's height above it) from the small breakpoint on. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:mt-7">
              <Button ref={addRef} variant="secondary" icon={<Plus aria-hidden="true" />} disabled={full} focusableWhenDisabled aria-describedby={full ? fullId : undefined} onClick={add}>
                {t('tracking.alerts.add')}
              </Button>
              {full && (
                <span id={fullId} className="text-sm font-semibold text-fg-muted">
                  {t('tracking.alerts.full', { max: MAX_ALERT_EMAILS })}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:justify-end">
            <p role="status" className="basis-full text-sm text-fg-muted sm:me-auto sm:basis-auto">
              {dirty ? t('settings.status.unsaved') : t('settings.status.saved')}
            </p>
            <Button
              variant="secondary"
              icon={<Undo2 aria-hidden="true" />}
              disabled={!dirty || save.isPending}
              focusableWhenDisabled
              // Named apart from the thresholds' own: two "Discard changes" on one page.
              aria-label={t('tracking.alerts.discardNamed')}
              onClick={() => {
                save.reset()
                form.validate({})
                onDraftChange(null)
              }}
            >
              {t('settings.discard')}
            </Button>
            <Button type="submit" icon={<Save aria-hidden="true" />} loading={save.isPending} disabled={!dirty} focusableWhenDisabled aria-label={t('tracking.alerts.saveNamed')}>
              {t('settings.save')}
            </Button>
          </div>
        </form>
      </div>
    </Card>
  )
}

/** The provider's health as the server counts it: contact, the last accepted event, refusals and failures of the last 24 hours. */
function HealthCard({ settings }: { settings: TrackingSettings }) {
  const { t } = useTranslation('admin')
  const { me } = useAuth()
  const timeZone = me?.company.timezone ?? 'UTC'
  const { health } = settings
  const when = (value: string | null) => (value ? <span className="tabular-nums">{formatDateTime(value, timeZone)}</span> : <span className="text-fg-muted">{t('tracking.health.never')}</span>)
  const counts = (rows: readonly { label: string; count: number }[]) =>
    rows.length === 0 ? (
      <span className="text-fg-muted">{t('tracking.health.none')}</span>
    ) : (
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.label} className="flex justify-between gap-3">
            <span className="min-w-0 break-words">{row.label}</span>
            <span className="font-numeric tabular-nums">{formatCount(row.count)}</span>
          </li>
        ))}
      </ul>
    )
  return (
    <Card title={t('tracking.health.title')}>
      <FactList
        items={[
          { term: t('tracking.health.lastContact'), description: when(health.last_contact_at) },
          { term: t('tracking.health.lastEvent'), description: when(health.last_accepted_event_at) },
          {
            term: t('tracking.health.rejected'),
            description: counts(health.rejected_last_24h.map((row) => ({ label: t(`tracking.health.reasons.${row.reason}`), count: row.count }))),
          },
          {
            term: t('tracking.health.providerErrors'),
            description: counts(health.provider_errors_last_24h.map((row) => ({ label: t(`tracking.health.operations.${row.operation}`), count: row.count }))),
          },
        ]}
      />
    </Card>
  )
}

export interface TrackingSettingsPanelProps {
  draft: ThresholdValues | null
  onDraftChange: (draft: ThresholdValues | null) => void
  /** The alert e-mails being edited (Phase 16); null: the saved ones. */
  emailsDraft: string[] | null
  onEmailsDraftChange: (draft: string[] | null) => void
}

export function TrackingSettingsPanel({ draft, onDraftChange, emailsDraft, onEmailsDraftChange }: TrackingSettingsPanelProps) {
  const { t } = useTranslation('admin')
  const settings = useTrackingSettings()
  if (settings.isError) return <LoadErrorAlert title={t('tracking.settings.loadError')} error={settings.error} onRetry={() => void settings.refetch()} />
  if (!settings.data) return <PageSpinner label={t('tracking.settings.loading')} />
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <TrackingSwitchCard settings={settings.data} />
        <HealthCard settings={settings.data} />
      </div>
      <ThresholdsCard settings={settings.data} draft={draft} onDraftChange={onDraftChange} />
      <AreaAlertsCard settings={settings.data} draft={emailsDraft} onDraftChange={onEmailsDraftChange} />
      <TrackingKeysCard />
    </div>
  )
}

import { Save, Undo2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Checkbox } from '../../components/ui/Checkbox'
import { Field } from '../../components/ui/Field'
import { Input } from '../../components/ui/Input'
import { RadioGroup } from '../../components/ui/RadioGroup'
import { StickyActionBar } from '../../components/ui/StickyActionBar'
import { Textarea } from '../../components/ui/Textarea'
import { useToast } from '../../components/ui/toastContext'
import { useFormErrors } from '../../hooks/useFormErrors'
import { useNow } from '../../hooks/useNow'
import { useStableId } from '../../hooks/useStableId'
import { LANGUAGE_NAMES, LANGUAGES, type Language } from '../../i18n'
import type { CompanySettings } from '../../types/api'
import { formatTimeZoneName } from '../../utils/datetime'
import { useUpdateCompanySettings } from './queries'
import {
  describeGraceMinutes,
  SETTINGS_FIELDS,
  settingsDirty,
  settingsValues,
  toSettingsUpdate,
  validateSettings,
  type SettingsField,
  type SettingsValues,
} from './settingsForm'
import { TimeZoneCombobox } from './TimeZoneCombobox'
import { UnsavedChangesGuard } from './UnsavedChangesGuard'

export interface CompanySettingsFormProps {
  settings: CompanySettings
}

/**
 * A number of minutes: a narrow field with its unit beside it ("min"). The unit is shown, not
 * read: the field's hint says the minutes in words ("90 minutes (1 hour 30 min)").
 */
function MinutesInput(props: { value: string; onChange: (event: { target: { value: string } }) => void }) {
  const { t } = useTranslation('admin')
  return (
    <span className="flex items-center gap-2">
      <Input type="number" inputMode="numeric" min={0} max={1440} step={1} className="max-w-28" {...props} />
      <span aria-hidden="true" className="text-sm text-fg-muted">
        {t('settings.minutesUnit')}
      </span>
    </span>
  )
}

/** A language option named in its own language and script, as the language switch names it. */
function languageOption(language: Language) {
  return { value: language, label: <span lang={language}>{LANGUAGE_NAMES[language].name}</span> }
}

/**
 * The company settings form (PATCH /company/settings) in direction C's cards, titles only: the
 * company, its language and time zone, the visitor pass window and the reception options. It sends
 * only what changed, compared with the settings the form was opened with, so a field nobody
 * touched is never overwritten.
 */
export function CompanySettingsForm({ settings }: CompanySettingsFormProps) {
  const { t } = useTranslation('admin')
  const toast = useToast()
  const now = useNow()
  const save = useUpdateCompanySettings()
  const [baseline, setBaseline] = useState(settings)
  const [values, setValues] = useState<SettingsValues>(() => settingsValues(settings))
  const form = useFormErrors(save.error, { fields: SETTINGS_FIELDS })
  const formId = useStableId('company-settings')
  const dirty = settingsDirty(baseline, values)

  const set = <K extends SettingsField>(key: K, value: SettingsValues[K]) => setValues((current) => ({ ...current, [key]: value }))
  const text = (key: 'name' | 'nameAr' | 'emailDomain' | 'graceBefore' | 'graceAfter') => ({
    value: values[key],
    onChange: (event: { target: { value: string } }) => set(key, event.target.value),
  })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateSettings(values))) return
    const body = toSettingsUpdate(baseline, values)
    if (!body) {
      setValues(settingsValues(baseline))
      return
    }
    save.mutate(body, {
      onSuccess: (saved) => {
        setBaseline(saved)
        setValues(settingsValues(saved))
        toast.show({
          tone: 'success',
          title: t('settings.saved'),
          description: body.timezone ? t('settings.savedTimezone', { zone: formatTimeZoneName(saved.timezone, now) }) : undefined,
        })
      },
    })
  }

  return (
    <>
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-6">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}

        <Card title={t('settings.company.title')}>
          <div className="grid grid-cols-1 gap-x-5 gap-y-4 md:grid-cols-2">
            <Field label={t('settings.company.name')} required {...form.field('name')}>
              <Input autoComplete="organization" {...text('name')} />
            </Field>
            {/* Typed in Arabic: right to left whatever the UI language. */}
            <Field label={t('settings.company.nameAr')} optional {...form.field('nameAr')}>
              <Input dir="rtl" lang="ar" autoComplete="off" {...text('nameAr')} />
            </Field>
            <Field label={t('settings.company.address')} optional {...form.field('address')}>
              <Textarea rows={3} value={values.address} onChange={(event) => set('address', event.target.value)} />
            </Field>
            {/* Typed in Arabic, as the Arabic name: the Arabic section of the e-mails shows it. */}
            <Field label={t('settings.company.addressAr')} optional {...form.field('addressAr')}>
              <Textarea dir="rtl" lang="ar" rows={3} value={values.addressAr} onChange={(event) => set('addressAr', event.target.value)} />
            </Field>
            <Field label={t('settings.company.emailDomain')} optional {...form.field('emailDomain')}>
              <Input dir="ltr" autoComplete="off" spellCheck={false} inputMode="url" {...text('emailDomain')} />
            </Field>
          </div>
        </Card>

        <Card title={t('settings.region.title')}>
          <div className="grid grid-cols-1 items-start gap-x-5 gap-y-4 md:grid-cols-2">
            <RadioGroup<Language>
              label={t('settings.language.label')}
              variant="segmented"
              value={values.defaultLanguage}
              onValueChange={(next) => set('defaultLanguage', next)}
              options={LANGUAGES.map(languageOption)}
              {...form.field('defaultLanguage')}
            />
            <Field label={t('settings.timezone.label')} required {...form.field('timezone')}>
              <TimeZoneCombobox value={values.timezone} onChange={(zone) => set('timezone', zone)} now={now} />
            </Field>
          </div>
        </Card>

        <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-2">
          <Card title={t('settings.passes.title')}>
            <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:gap-x-5">
              <Field label={t('settings.passes.before')} hint={describeGraceMinutes(values.graceBefore)} {...form.field('graceBefore')}>
                <MinutesInput {...text('graceBefore')} />
              </Field>
              <Field label={t('settings.passes.after')} hint={describeGraceMinutes(values.graceAfter)} {...form.field('graceAfter')}>
                <MinutesInput {...text('graceAfter')} />
              </Field>
            </div>
          </Card>

          <Card title={t('settings.reception.title')}>
            <div className="flex flex-col gap-4">
              <Checkbox
                label={t('settings.reception.notifyHost')}
                checked={values.notifyHostOnCheckIn}
                onChange={(event) => set('notifyHostOnCheckIn', event.target.checked)}
              />
              <Checkbox
                label={t('settings.reception.walkIns')}
                checked={values.allowWalkIns}
                onChange={(event) => set('allowWalkIns', event.target.checked)}
              />
            </div>
          </Card>
        </div>

        {/*
         * Status, the safe choice, then the primary action: one order to read, see and tab
         * through. The bar stays at the bottom of the screen, edge to edge, while the form
         * scrolls (as the walk-in form's, FY-5), so an edit at the top has its Save in view.
         */}
        <StickyActionBar className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:flex-nowrap sm:justify-end">
          {/* Phones: the status over the two buttons side by side (each wraps to its own row when they do not fit). */}
          <p role="status" className="basis-full text-sm text-fg-muted sm:me-auto sm:basis-auto">
            {dirty ? t('settings.status.unsaved') : t('settings.status.saved')}
          </p>
          <Button
            variant="secondary"
            className="flex-1 sm:flex-none"
            icon={<Undo2 aria-hidden="true" />}
            disabled={!dirty || save.isPending}
            focusableWhenDisabled
            onClick={() => setValues(settingsValues(baseline))}
          >
            {t('settings.discard')}
          </Button>
          <Button type="submit" className="flex-1 sm:flex-none" icon={<Save aria-hidden="true" />} loading={save.isPending} disabled={!dirty} focusableWhenDisabled>
            {t('settings.save')}
          </Button>
        </StickyActionBar>
      </form>

      <UnsavedChangesGuard dirty={dirty && !save.isPending} description={t('settings.unsavedDescription')} />
    </>
  )
}

import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { Field } from '../../components/ui/Field'
import { Input } from '../../components/ui/Input'
import { RadioGroup } from '../../components/ui/RadioGroup'
import { useToast } from '../../components/ui/toastContext'
import { useFormErrors } from '../../hooks/useFormErrors'
import { useNow } from '../../hooks/useNow'
import { useStableId } from '../../hooks/useStableId'
import { LANGUAGE_NAMES, LANGUAGES, type Language } from '../../i18n'
import type { PlatformCompany } from '../../types/api'
import { TimeZoneCombobox } from '../admin/TimeZoneCombobox'
import { COMPANY_EDIT_FIELDS, companyIdentityValues, toCompanyUpdate, validateCompanyEdit, type CompanyIdentityValues } from './companyForm'
import { useUpdatePlatformCompany } from './queries'

export interface EditCompanyDialogProps {
  company: PlatformCompany
  /** The company's name as the page shows it. */
  displayName: string
  onClose: () => void
}

/**
 * A company's identity (PATCH /platform/companies/{id}): its names, time zone and default
 * language; the slug never changes (B11-12). Only what changed is sent; an emptied Arabic name is
 * sent as null, so the company name is used again.
 */
export function EditCompanyDialog({ company, displayName, onClose }: EditCompanyDialogProps) {
  const { t } = useTranslation('platform')
  const toast = useToast()
  const now = useNow()
  const update = useUpdatePlatformCompany(company.id)
  const [values, setValues] = useState<CompanyIdentityValues>(() => companyIdentityValues(company))
  const form = useFormErrors<keyof CompanyIdentityValues>(update.error, { fields: COMPANY_EDIT_FIELDS })
  const formId = useStableId('edit-company')
  const set = <K extends keyof CompanyIdentityValues>(key: K, value: CompanyIdentityValues[K]) => {
    const next = { ...values, [key]: value }
    setValues(next)
    if (form.attempted) form.refresh(validateCompanyEdit(next))
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateCompanyEdit(values))) return
    const body = toCompanyUpdate(company, values)
    if (!body) {
      onClose()
      return
    }
    update.mutate(body, {
      onSuccess: () => {
        toast.show({ tone: 'success', title: t('company.saved') })
        onClose()
      },
    })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('company.editTitle', { name: displayName })}
      size="lg"
      dismissible={!update.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={update.isPending} focusableWhenDisabled>
            {t('company.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={update.isPending}>
            {t('company.save')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        {form.formError && <Alert tone="danger">{form.formError}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label={t('form.name')} required {...form.field('name')}>
            <Input autoComplete="off" dir="auto" value={values.name} onChange={(event) => set('name', event.target.value)} />
          </Field>
          <Field label={t('form.nameAr')} optional {...form.field('nameAr')}>
            <Input autoComplete="off" dir="rtl" lang="ar" value={values.nameAr} onChange={(event) => set('nameAr', event.target.value)} />
          </Field>
        </div>
        <Field label={t('form.timezone')} required {...form.field('timezone')}>
          <TimeZoneCombobox value={values.timezone} onChange={(zone) => set('timezone', zone)} now={now} />
        </Field>
        <RadioGroup<Language>
          label={t('form.language')}
          variant="segmented"
          value={values.defaultLanguage}
          onValueChange={(language) => set('defaultLanguage', language)}
          options={LANGUAGES.map((language) => ({ value: language, label: <span lang={language}>{LANGUAGE_NAMES[language].name}</span> }))}
          {...form.field('defaultLanguage')}
        />
      </form>
    </Dialog>
  )
}

import { Building2, Check } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { rateLimitWaitSeconds } from '../../api/client'
import { Alert } from '../../components/ui/Alert'
import { Button, ButtonLink } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Field } from '../../components/ui/Field'
import { Input } from '../../components/ui/Input'
import { PageHeader } from '../../components/ui/PageHeader'
import { RadioGroup } from '../../components/ui/RadioGroup'
import { useFormErrors } from '../../hooks/useFormErrors'
import { useNow } from '../../hooks/useNow'
import { useStableId } from '../../hooks/useStableId'
import { LANGUAGE_NAMES, LANGUAGES, type Language } from '../../i18n'
import { useCompanyName } from '../../i18n/useLanguage'
import { paths } from '../../paths'
import type { PlatformCompanyCreated } from '../../types/api'
import { formatWaitDuration } from '../../utils/duration'
import { TemporaryPasswordField } from '../admin/TemporaryPasswordField'
import { TimeZoneCombobox } from '../admin/TimeZoneCombobox'
import {
  EMPTY_NEW_COMPANY,
  NEW_COMPANY_CODES,
  NEW_COMPANY_FIELDS,
  toCompanyCreate,
  validateNewCompany,
  withName,
  type NewCompanyField,
  type NewCompanyValues,
} from './companyForm'
import { useCreatePlatformCompany } from './queries'
import { TemporaryPasswordReveal } from './TemporaryPasswordReveal'

/** A language option named in its own language and script, as the language switch names it. */
function languageOption(language: Language) {
  return { value: language, label: <span lang={language}>{LANGUAGE_NAMES[language].name}</span> }
}

/** The company and its first administrator, once: the temporary password is shown here and nowhere else. */
function CompanyCreated({ created, temporaryPassword }: { created: PlatformCompanyCreated; temporaryPassword: string }) {
  const { t } = useTranslation('platform')
  const companyName = useCompanyName(created.company)
  return (
    <>
      <PageHeader title={t('created.title')} back={{ to: paths.platformCompanies, label: t('company.back') }} />
      <Card className="max-w-2xl" title={companyName}>
        <div className="flex flex-col gap-5">
          <p className="text-sm text-fg-secondary">{t('created.description')}</p>
          <TemporaryPasswordReveal
            fullName={created.admin.full_name}
            email={created.admin.email}
            temporaryPassword={temporaryPassword}
            companyActive={created.company.is_active}
            focusOnShow
          />
          <div className="flex flex-col gap-2 border-t border-border-subtle pt-4 sm:flex-row sm:justify-end">
            <ButtonLink to={paths.platformCompanies} variant="secondary">
              {t('created.back')}
            </ButtonLink>
            <ButtonLink to={paths.platformCompany(created.company.id)} icon={<Building2 aria-hidden="true" className="size-5" />}>
              {t('created.open')}
            </ButtonLink>
          </div>
        </div>
      </Card>
    </>
  )
}

/**
 * /platform/companies/new: a company (its names, a slug suggested from the English name, time zone
 * and default language) and its first administrator with a temporary password (B11-12), which the
 * page shows once more after the company exists. The password lives only in this page's state and
 * in a mutation dropped when the page goes.
 */
export function NewCompanyPage() {
  const { t } = useTranslation(['platform', 'admin'])
  const now = useNow()
  const create = useCreatePlatformCompany()
  const [values, setValues] = useState<NewCompanyValues>(EMPTY_NEW_COMPANY)
  const [created, setCreated] = useState<{ result: PlatformCompanyCreated; temporaryPassword: string } | null>(null)
  const form = useFormErrors<NewCompanyField>(create.error, { fields: NEW_COMPANY_FIELDS, codes: NEW_COMPANY_CODES })
  const formId = useStableId('new-company')
  // Too many addresses were refused (429, B11-42): the form says how long to wait, from `Retry-After`.
  const wait = rateLimitWaitSeconds(create.error)
  const formError = wait !== null ? t('form.limited', { duration: formatWaitDuration(wait) }) : form.formError

  if (created) return <CompanyCreated created={created.result} temporaryPassword={created.temporaryPassword} />

  /** A change; after a refused submit the form is checked again as it is corrected (without moving focus). */
  const change = (next: NewCompanyValues) => {
    setValues(next)
    if (form.attempted) form.refresh(validateNewCompany(next))
  }
  const set = <K extends keyof NewCompanyValues>(key: K, value: NewCompanyValues[K]) => change({ ...values, [key]: value })

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.validate(validateNewCompany(values))) return
    create.mutate(toCompanyCreate(values), { onSuccess: (result) => setCreated({ result, temporaryPassword: values.adminPassword }) })
  }

  return (
    <>
      <PageHeader title={t('companies.add')} back={{ to: paths.platformCompanies, label: t('company.back') }} />
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-6">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
          <Card title={t('form.companySection')}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('form.name')} required {...form.field('name')}>
                <Input autoComplete="off" dir="auto" value={values.name} onChange={(event) => change(withName(values, event.target.value))} />
              </Field>
              <Field label={t('form.nameAr')} optional {...form.field('nameAr')}>
                <Input autoComplete="off" dir="rtl" lang="ar" value={values.nameAr} onChange={(event) => set('nameAr', event.target.value)} />
              </Field>
              <Field label={t('form.slug')} required {...form.field('slug')}>
                <Input
                  autoComplete="off"
                  dir="ltr"
                  spellCheck={false}
                  autoCapitalize="none"
                  className="font-mono"
                  value={values.slug}
                  onChange={(event) => change({ ...values, slug: event.target.value, slugEdited: true })}
                />
              </Field>
              <RadioGroup<Language>
                label={t('form.language')}
                variant="segmented"
                value={values.defaultLanguage}
                onValueChange={(language) => set('defaultLanguage', language)}
                options={LANGUAGES.map(languageOption)}
                {...form.field('defaultLanguage')}
              />
              <Field label={t('form.timezone')} required className="sm:col-span-2" {...form.field('timezone')}>
                <TimeZoneCombobox value={values.timezone} onChange={(zone) => set('timezone', zone)} now={now} />
              </Field>
            </div>
          </Card>
          <Card title={t('form.adminSection')}>
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t('form.fullName')} required {...form.field('adminFullName')}>
                  <Input autoComplete="off" value={values.adminFullName} onChange={(event) => set('adminFullName', event.target.value)} />
                </Field>
                <Field label={t('form.email')} required {...form.field('adminEmail')}>
                  <Input
                    type="email"
                    inputMode="email"
                    autoComplete="off"
                    spellCheck={false}
                    dir="ltr"
                    value={values.adminEmail}
                    onChange={(event) => set('adminEmail', event.target.value)}
                  />
                </Field>
              </div>
              <TemporaryPasswordField
                {...form.field('adminPassword')}
                value={values.adminPassword}
                email={values.adminEmail}
                onChange={(password) => set('adminPassword', password)}
              />
            </div>
          </Card>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <ButtonLink to={paths.platformCompanies} variant="secondary">
            {t('form.cancel')}
          </ButtonLink>
          <Button type="submit" loading={create.isPending} icon={<Check aria-hidden="true" />}>
            {t('form.create')}
          </Button>
        </div>
      </form>
    </>
  )
}

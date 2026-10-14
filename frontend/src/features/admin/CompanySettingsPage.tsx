
import { useTranslation } from 'react-i18next'
import { useCompanySettings } from '../../api/queries'
import { PageHeader } from '../../components/ui/PageHeader'
import { PageSpinner } from '../../components/ui/Spinner'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { CompanySettingsForm } from './CompanySettingsForm'

/** /admin/settings: company name, time zone, address, email domain, pass window, reception options. */
export function CompanySettingsPage() {
  const { t } = useTranslation('admin')
  const settings = useCompanySettings()
  return (
    <>
      <PageHeader title={t('settings.title')} />
      {settings.isError ? (
        <LoadErrorAlert title={t('settings.loadError')} error={settings.error} onRetry={() => void settings.refetch()} />
      ) : settings.data ? (
        // The form keeps the settings it was opened with; a refetch never overwrites edits.
        <CompanySettingsForm key={settings.data.id} settings={settings.data} />
      ) : (
        <PageSpinner label={t('settings.loading')} />
      )}
    </>
  )
}

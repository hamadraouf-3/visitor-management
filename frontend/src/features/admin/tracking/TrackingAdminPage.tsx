import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '../../../components/ui/PageHeader'
import { TabPanel, Tabs } from '../../../components/ui/Tabs'
import { readEnumParam, useUrlParams } from '../../../hooks/useUrlParams'
import { CamerasPanel } from './CamerasPanel'
import { LocationsPanel } from './LocationsPanel'
import { TrackingSettingsPanel } from './TrackingSettingsPanel'
import { useTrackingSettings } from './queries'
import { alertEmailsDirty, thresholdsDirty, type ThresholdValues } from './trackingForms'
import { UnsavedChangesGuard } from '../UnsavedChangesGuard'

const TRACKING_TABS = ['settings', 'locations', 'cameras'] as const
type TrackingTab = (typeof TRACKING_TABS)[number]

const TABS_ID = 'tracking-admin'

/**
 * /admin/tracking (Phase 15), «تتبّع الزوار» / "Visitor tracking", the company administrator's: the switch,
 * the thresholds, the area alerts (Phase 16), the provider's health and keys (Settings); the buildings,
 * floors and zones with their access levels (Locations); the cameras the provider reports by its own IDs
 * (Cameras). The tab is in the address (`?tab=`). The thresholds and the alert e-mails being edited are kept
 * here, so a look at another tab loses nothing, and leaving with either unsaved asks first.
 */
export function TrackingAdminPage() {
  const { t } = useTranslation('admin')
  const [params, updateParams] = useUrlParams()
  const tab = readEnumParam(params, 'tab', TRACKING_TABS, 'settings')
  const [thresholdDraft, setThresholdDraft] = useState<ThresholdValues | null>(null)
  const [emailsDraft, setEmailsDraft] = useState<string[] | null>(null)
  const settings = useTrackingSettings()
  const dirty =
    settings.data !== undefined &&
    ((thresholdDraft !== null && thresholdsDirty(settings.data, thresholdDraft)) || alertEmailsDirty(settings.data, emailsDraft))
  const labels: Record<TrackingTab, string> = {
    settings: t('tracking.tabs.settings'),
    locations: t('tracking.tabs.locations'),
    cameras: t('tracking.tabs.cameras'),
  }
  return (
    <>
      <PageHeader title={t('tracking.title')} />
      <Tabs
        idBase={TABS_ID}
        label={t('tracking.tabs.label')}
        value={tab}
        onValueChange={(next) => updateParams({ tab: next === 'settings' ? null : next })}
        className="mb-2"
        items={TRACKING_TABS.map((value) => ({ value, label: labels[value] }))}
      />
      <TabPanel idBase={TABS_ID} value="settings" selected={tab}>
        <TrackingSettingsPanel draft={thresholdDraft} onDraftChange={setThresholdDraft} emailsDraft={emailsDraft} onEmailsDraftChange={setEmailsDraft} />
      </TabPanel>
      <TabPanel idBase={TABS_ID} value="locations" selected={tab}>
        <LocationsPanel />
      </TabPanel>
      <TabPanel idBase={TABS_ID} value="cameras" selected={tab}>
        <CamerasPanel onOpenLocations={() => updateParams({ tab: 'locations' })} />
      </TabPanel>
      <UnsavedChangesGuard dirty={dirty} description={t('tracking.settings.unsavedDescription')} />
    </>
  )
}

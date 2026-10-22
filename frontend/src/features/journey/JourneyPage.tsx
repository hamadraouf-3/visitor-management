import { useLayoutEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../auth/useAuth'
import { LiveIndicator } from '../../components/ui/LiveIndicator'
import { MetaLine } from '../../components/ui/MetaLine'
import { PageHeader } from '../../components/ui/PageHeader'
import { tabId } from '../../components/ui/tabIds'
import { TabPanel, Tabs } from '../../components/ui/Tabs'
import { useNow } from '../../hooks/useNow'
import { readEnumParam, readUuidParam, useUrlParams } from '../../hooks/useUrlParams'
import type { Me } from '../../types/api'
import { formatClockTime } from '../../utils/datetime'
import { formatCount } from '../../utils/number'
import { JourneyList } from './JourneyList'
import { JOURNEY_VIEW_TABS, JOURNEY_VIEWS, VIEW_PARAM, type JourneyView } from './journeyView'
import { BUILDING_PARAM, LiveMap } from './LiveMap'
import { chosenBuilding, mapBuildings } from './liveMapModel'
import { useLiveJourneys, useLocationTree, useTrackingStatus } from './queries'
import { TrackingStatusBanner } from './TrackingStatusBanner'
import { trackingBanner } from './trackingStatus'

/**
 * The two views are different pages under one tab list: a switch unmounts the tab list that had the focus. Set
 * by a switch made on the tabs, so the new view's tab list gives its selected tab the focus (F16-40); never on a
 * page's first load, which must not take the focus.
 */
let focusViewTab = false

/** «الخريطة الحية» / «القائمة»: the view switch under the page's title, kept in the address. */
function ViewTabs({ view }: { view: JourneyView }) {
  const { t } = useTranslation('journey')
  const [, updateParams] = useUrlParams()
  useLayoutEffect(() => {
    if (!focusViewTab) return
    focusViewTab = false
    document.getElementById(tabId(JOURNEY_VIEW_TABS, view))?.focus()
  }, [view])
  return (
    <Tabs
      idBase={JOURNEY_VIEW_TABS}
      label={t('view.label')}
      value={view}
      onValueChange={(next) => {
        if (next === view) return
        focusViewTab = true
        // The list's page goes with it: a page of the list means nothing on the map.
        updateParams({ [VIEW_PARAM]: next === 'map' ? null : next, page: null })
      }}
      className="mb-2"
      items={JOURNEY_VIEWS.map((value) => ({ value, label: t(`view.${value}`) }))}
    />
  )
}

/** The live map with the page around it: when it was updated, how many are inside, the tracking line. */
function LiveMapView({ me }: { me: Me }) {
  const { t } = useTranslation('journey')
  const [params] = useUrlParams()
  const now = useNow(15_000)
  const status = useTrackingStatus()
  const locations = useLocationTree()
  const buildings = mapBuildings(locations.data)
  const building = chosenBuilding(buildings, readUuidParam(params, BUILDING_PARAM))
  const live = useLiveJourneys(building !== null)
  const answer = live.data?.live
  const simulatedShown = status.data !== undefined && trackingBanner(status.data).simulated

  return (
    <>
      <PageHeader
        title={t('title')}
        meta={
          <div className="min-h-5">
            {answer && (
              <MetaLine
                items={[
                  <LiveIndicator key="updated" label={t('live.updated', { time: formatClockTime(answer.generated_at, me.company.timezone) })} />,
                  t('live.visitors', { count: answer.visitors.length, formatted: formatCount(answer.visitors.length) }),
                ]}
              />
            )}
          </div>
        }
      />
      <ViewTabs view="map" />
      <TabPanel idBase={JOURNEY_VIEW_TABS} value="map" selected="map">
        <TrackingStatusBanner status={status.data} />
        <LiveMap me={me} simulatedShown={simulatedShown} now={now} live={live} building={building} buildings={buildings} locations={locations} />
      </TabPanel>
    </>
  )
}

/**
 * /journey (Phase 15; the live map, Phase 16): «الخريطة الحية» / "Live map" by default, everyone inside now
 * on their building's floors; «القائمة» / "List" (`?view=list`), the day's visits and their journeys.
 */
export function JourneyPage() {
  const { me } = useAuth()
  const [params] = useUrlParams()
  if (!me) return null
  const view = readEnumParam(params, VIEW_PARAM, JOURNEY_VIEWS, 'map')
  return view === 'list' ? <JourneyList me={me} viewSwitch={<ViewTabs view="list" />} /> : <LiveMapView me={me} />
}

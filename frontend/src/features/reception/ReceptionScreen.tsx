import { CalendarDays, DoorOpen, ScanQrCode, Search, UserPlus, UserRoundCheck, type LucideIcon } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { MetaLine } from '../../components/ui/MetaLine'
import { PageHeader } from '../../components/ui/PageHeader'
import { TabPanel, Tabs, type TabItem } from '../../components/ui/Tabs'
import { useToast } from '../../components/ui/toastContext'
import { useNow } from '../../hooks/useNow'
import { readEnumParam, useUrlParams } from '../../hooks/useUrlParams'
import type { DecoderPreloadState } from '../../scanner/useQrDecoderPreload'
import type { Me, Visit } from '../../types/api'
import { formatDate, formatTime, utcToWallTime } from '../../utils/datetime'
import { ExpectedPanel } from './ExpectedPanel'
import { InsidePanel } from './InsidePanel'
import { useReceptionToday } from './queries'
import { DEFAULT_RECEPTION_TAB, RECEPTION_TAB_LABELS, RECEPTION_TABS, receptionTabParam, type ReceptionTab } from './receptionTabs'
import { ScanPanel } from './ScanPanel'
import { TodayCounts } from './TodayCounts'
import { useScanStation } from './useScanStation'
import { VisitorSearchDialog } from './VisitorSearchDialog'
import { initialWalkInValues, type WalkInPrefill } from './walkInForm'
import { WalkInPanel, type WalkInDraft } from './WalkInPanel'

const TABS_ID = 'reception'

/** Direction C's tab icons (decorative: each tab is named by its label). */
const TAB_ICONS: Record<ReceptionTab, LucideIcon> = {
  scan: ScanQrCode,
  expected: UserRoundCheck,
  inside: DoorOpen,
  'walk-in': UserPlus,
}

/** The desk's clock in the company time zone, large in Space Grotesk (direction C's header). */
function ReceptionClock({ timeZone }: { timeZone: string }) {
  const now = useNow(10_000)
  return (
    <time
      dateTime={utcToWallTime(now, timeZone)}
      className="font-numeric text-[1.75rem] leading-none font-semibold tracking-tight text-fg tabular-nums max-sm:hidden"
    >
      {formatTime(now, timeZone)}
    </time>
  )
}

export interface ReceptionScreenProps {
  me: Me
  decoder: DecoderPreloadState
}

/**
 * The reception screen (§10), direction C's dark reception tablet: the title with today's date,
 * the desk's clock and "Find a visitor"; today's numbers as a strip of KPI tiles; then four
 * full-width tabs, Scan (the default) · Expected · Inside · Walk-in, kept in the URL, with the
 * Expected and Inside counts on their tabs. "Find a visitor" opens the search over the screen.
 *
 * The scanner lives here rather than in its tab, so the camera stream stays open for the whole
 * visit to the screen (decoding pauses on the other tabs), and a walk-in being entered survives
 * a quick scan in between. A scan result about a visit that a list or the search then checks in
 * or out is left, because its actions no longer apply.
 */
export function ReceptionScreen({ me, decoder }: ReceptionScreenProps) {
  const { t } = useTranslation('reception')
  const timeZone = me.company.timezone
  const now = useNow()
  const toast = useToast()
  const [params, updateParams] = useUrlParams()
  const tab = readEnumParam(params, 'tab', RECEPTION_TABS, DEFAULT_RECEPTION_TAB)
  const today = useReceptionToday()
  const [searchOpen, setSearchOpen] = useState(false)
  // A pass the camera reads while the search is open is shown at once, not behind the dialog.
  const closeSearch = useCallback(() => setSearchOpen(false), [])
  const station = useScanStation({ scanTabActive: tab === 'scan', decoder, onCameraScan: closeSearch })
  const [walkInDraft, setWalkInDraft] = useState<WalkInDraft | null>(null)
  // The Scan tab opens with focus lost because a walk-in closed its tab: the pass entry takes it.
  const [scanFocusOnOpen, setScanFocusOnOpen] = useState(false)

  const selectTab = useCallback(
    (next: ReceptionTab) => {
      setScanFocusOnOpen(false)
      updateParams({ tab: receptionTabParam(next) })
    },
    [updateParams],
  )

  const startWalkIn = useCallback(
    (prefill: WalkInPrefill) => {
      setWalkInDraft({
        values: initialWalkInValues(prefill),
        loadVisitorId: prefill.visitorId ?? null,
        loadHost: prefill.hostRef ?? null,
        prefillDepartment: prefill.department ?? null,
      })
      selectTab('walk-in')
    },
    [selectTab],
  )

  const { dismissIfAbout } = station
  const visitChanged = useCallback((changed: Visit) => dismissIfAbout((visit) => visit.id === changed.id), [dismissIfAbout])
  // The bulk check-out names no visits: a shown result about any visitor from a previous day goes.
  const staleCheckedOut = useCallback(() => dismissIfAbout((visit) => visit.is_stale && visit.is_overdue), [dismissIfAbout])

  const walkInCreated = (visit: Visit) => {
    toast.show({ tone: 'success', title: t('checkedIn', { name: visit.visitor.full_name }), description: t('walkIn.registered') })
    setWalkInDraft(null)
    selectTab('scan')
    setScanFocusOnOpen(true)
  }

  const counts = today.data?.counts
  const items: TabItem<ReceptionTab>[] = RECEPTION_TABS.map((value) => {
    const Icon = TAB_ICONS[value]
    return {
      value,
      label: (
        <>
          <Icon aria-hidden="true" className="size-5 shrink-0" />
          {RECEPTION_TAB_LABELS[value]}
        </>
      ),
      badge: value === 'expected' ? counts?.expected : value === 'inside' ? counts?.inside : undefined,
    }
  })

  return (
    <>
      <PageHeader
        title={t('title')}
        meta={
          <MetaLine
            items={[
              <>
                <CalendarDays aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
                {formatDate(now, timeZone)}
              </>,
            ]}
          />
        }
        actions={
          <div className="flex items-center gap-5">
            <ReceptionClock timeZone={timeZone} />
            <Button variant="secondary" icon={<Search aria-hidden="true" />} onClick={() => setSearchOpen(true)}>
              {t('search.open')}
            </Button>
          </div>
        }
        actionsBesideTitle
        // The camera starts near the top of a tablet's screen.
        compact
      />

      <TodayCounts counts={counts} failed={today.isError} onRetry={() => void today.refetch()} className="mb-4" />

      <Tabs
        idBase={TABS_ID}
        label={t('title')}
        items={items}
        value={tab}
        onValueChange={selectTab}
        size="xl"
        phoneLayout="grid"
        // Direction C: one track across the screen, its segments sharing the width.
        className="w-full sm:[&_[role=tab]]:flex-1"
      />
      <TabPanel idBase={TABS_ID} value="scan" selected={tab}>
        <ScanPanel
          station={station}
          timeZone={timeZone}
          expected={today.data?.expected}
          onWalkIn={startWalkIn}
          onShowExpected={() => selectTab('expected')}
          focusPassEntryOnOpen={scanFocusOnOpen}
        />
      </TabPanel>
      <TabPanel idBase={TABS_ID} value="expected" selected={tab}>
        <ExpectedPanel
          today={today.data}
          loading={today.isPending}
          error={today.error}
          onRetry={() => void today.refetch()}
          timeZone={timeZone}
          onWalkIn={startWalkIn}
          onVisitChanged={visitChanged}
        />
      </TabPanel>
      <TabPanel idBase={TABS_ID} value="inside" selected={tab}>
        <InsidePanel timeZone={timeZone} onVisitChanged={visitChanged} onStaleCheckedOut={staleCheckedOut} />
      </TabPanel>
      <TabPanel idBase={TABS_ID} value="walk-in" selected={tab}>
        <WalkInPanel timeZone={timeZone} draft={walkInDraft} onDraftChange={setWalkInDraft} onCreated={walkInCreated} />
      </TabPanel>

      {searchOpen && (
        <VisitorSearchDialog
          timeZone={timeZone}
          onClose={closeSearch}
          onWalkIn={startWalkIn}
          onVisitChanged={visitChanged}
          noShows={today.data?.no_show}
        />
      )}
    </>
  )
}

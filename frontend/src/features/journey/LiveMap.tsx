import { Layers, MapPinned, Settings2, UserX, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { hasRole } from '../../auth/roles'
import { ButtonLink } from '../../components/ui/Button'
import { EmptyState } from '../../components/ui/EmptyState'
import { Field } from '../../components/ui/Field'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { Select } from '../../components/ui/Select'
import { PageSpinner } from '../../components/ui/Spinner'
import { useStableId } from '../../hooks/useStableId'
import { useUrlParams } from '../../hooks/useUrlParams'
import { useLanguage } from '../../i18n/useLanguage'
import { paths } from '../../paths'
import type { Me } from '../../types/api'
import { cn } from '../../utils/cn'
import { focusPageHeading, isFocusLost } from '../../utils/focus'
import { formatCount } from '../../utils/number'
import { agoSeconds } from './freshness'
import { chosenBuilding, liveMapModel, mapBuildings, type FloorBand, type ZoneTile } from './liveMapModel'
import { LiveVisitorChip } from './LiveVisitorChip'
import { LiveVisitorPanel } from './LiveVisitorPanel'
import { LocationPath } from './LocationPath'
import { locationName, useLocationName } from './locationNames'
import { useLiveJourneys, useLocationTree, type AnsweredLiveJourneys } from './queries'
import type { LiveVisitor } from './types'
import { ZoneAccessBadge } from './ZoneAccessBadge'

/** The building shown, in the address (\`?building=\`), when the company has several. */
export const BUILDING_PARAM = 'building'

interface ChipContext {
  now: number
  answeredAt: number
  simulatedShown: boolean
  onOpen: (visitId: string) => void
}

function chips(visitors: readonly LiveVisitor[], { now, answeredAt, simulatedShown, onOpen }: ChipContext) {
  return visitors.map((visitor) => (
    <li key={visitor.visit.id} className="max-w-full">
      <LiveVisitorChip
        visitor={visitor}
        agoSeconds={visitor.freshness_seconds === null ? null : agoSeconds(visitor.freshness_seconds, answeredAt, now)}
        simulatedShown={simulatedShown}
        onOpen={onOpen}
      />
    </li>
  ))
}

/** A zone as a tile: its name, its access level when common or restricted, and the visitors in it now. */
function ZoneTileView({ tile, context }: { tile: ZoneTile; context: ChipContext }) {
  const { t } = useTranslation('journey')
  const name = useLocationName()
  const headingId = useStableId('zone')
  const occupied = tile.visitors.length > 0
  return (
    <section
      aria-labelledby={headingId}
      data-zone-tile={tile.zone.id}
      className={cn('flex min-w-0 flex-col gap-2.5 rounded-item border p-3', occupied ? 'border-border bg-surface' : 'border-border-subtle bg-surface-sunken')}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 id={headingId} className={cn('min-w-0 text-sm leading-snug font-semibold break-words', occupied ? 'text-fg' : 'text-fg-secondary')}>
          <bdi>{name(tile.zone)}</bdi>
        </h3>
        <ZoneAccessBadge access={tile.zone.access} />
        {tile.archived && <span className="text-meta text-fg-muted">{t('areas.archived')}</span>}
        {occupied && (
          <span className="ms-auto font-numeric text-meta font-semibold text-fg-secondary tabular-nums">
            <span aria-hidden="true">{formatCount(tile.visitors.length)}</span>
            <span className="sr-only">{t('live.visitors', { count: tile.visitors.length, formatted: formatCount(tile.visitors.length) })}</span>
          </span>
        )}
      </div>
      {occupied && <ul className="flex flex-wrap gap-2">{chips(tile.visitors, context)}</ul>}
    </section>
  )
}

/** A floor as a band: its name (with its building's when it is another building's, F16-36), how many visitors are on it, and its zones as tiles. */
function FloorBandView({ band, context }: { band: FloorBand; context: ChipContext }) {
  const { t } = useTranslation('journey')
  const name = useLocationName()
  const headingId = useStableId('floor')
  return (
    <section aria-labelledby={headingId} data-floor-band={band.floor.id} className="min-w-0 rounded-card border border-border bg-surface">
      {/* No level beside the name (the owner's follow-up, F16-32): a bare number in a chip read as a count of visitors. */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-subtle px-4 py-3 sm:px-5">
        <h2 id={headingId} className="min-w-0 text-section font-bold break-words text-fg">
          {band.building ? <LocationPath places={[band.building, band.floor]} /> : <bdi>{name(band.floor)}</bdi>}
        </h2>
        {band.archived && <span className="text-meta text-fg-muted">{t('areas.archived')}</span>}
        <span data-floor-count={band.count} className="ms-auto inline-flex items-center gap-1.5 text-sm font-medium text-fg-secondary">
          <Users aria-hidden="true" className="size-4 text-fg-muted" />
          {t('live.visitors', { count: band.count, formatted: formatCount(band.count) })}
        </span>
      </header>
      <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 sm:p-4 2xl:grid-cols-3">
        {band.zones.map((tile) => (
          <ZoneTileView key={tile.zone.id} tile={tile} context={context} />
        ))}
      </div>
    </section>
  )
}

export interface LiveMapProps {
  me: Me
  /** The page's line says Simulated: the chips leave it out. */
  simulatedShown: boolean
  /** The time now (\`useNow\`), for how long ago. */
  now: number
  /** The live answer, owned by the page (its header says when it was updated). */
  live: ReturnType<typeof useLiveJourneys>
  /** The building shown, and the company's buildings, as the page chose them. */
  building: ReturnType<typeof chosenBuilding>
  buildings: ReturnType<typeof mapBuildings>
  locations: ReturnType<typeof useLocationTree>
}

/**
 * The live map (Phase 16, «الخريطة الحية»): every visitor inside now, where the journey's confirmed place puts
 * them. The building's floors stacked highest first, each a band with its visitors' count and its zones as
 * tiles (common and restricted ones marked); each visitor a chip in their zone, in the alerts' red with a sign
 * while they have an active alert, dashed when the place is not recent. Beside them, «بدون موقع» / "No
 * location" (tracked, no usable place) and the count «غير متتبَّع» / "Not tracked". A chip opens the visitor's
 * panel. Asked again every 15 s.
 */
export function LiveMap({ me, simulatedShown, now, live, building, buildings, locations }: LiveMapProps) {
  const { t } = useTranslation('journey')
  const { language } = useLanguage()
  const [, updateParams] = useUrlParams()
  // The visitor whose panel is open, or was last: once it is closed, their chip takes the focus back.
  const [panel, setPanel] = useState<{ visitId: string; open: boolean } | null>(null)
  const openVisitId = panel?.open ? panel.visitId : null
  const noLocationId = useStableId('live-no-location')
  const data: AnsweredLiveJourneys | undefined = live.data

  // The sheet gives the focus back to the chip it was opened from. When the refresh moved that visitor to another
  // tile meanwhile (or off the map), that chip is gone: their chip now takes it, else the page's heading (F16-41).
  // The sheet's own clean-up has run by then.
  useEffect(() => {
    if (panel === null || panel.open || !isFocusLost()) return
    const chip = document.querySelector<HTMLElement>(`[data-live-chip="${panel.visitId}"]`)
    if (chip) chip.focus()
    else focusPageHeading()
  }, [panel])

  if (locations.isError) return <LoadErrorAlert title={t('areas.loadError')} error={locations.error} onRetry={() => void locations.refetch()} />
  if (!locations.data) return <PageSpinner label={t('live.loading')} />
  if (buildings.length === 0 || building === null) {
    return (
      <EmptyState
        icon={MapPinned}
        title={t('live.empty.noLocations')}
        action={
          hasRole(me.user.roles, 'SYSTEM_ADMIN') && (
            <ButtonLink to={`${paths.adminTracking}?tab=locations`} variant="secondary" icon={<Settings2 aria-hidden="true" />}>
              {t('live.empty.setUp')}
            </ButtonLink>
          )
        }
      />
    )
  }
  if (live.isError) return <LoadErrorAlert title={t('live.loadError')} error={live.error} onRetry={() => void live.refetch()} />
  if (!data) return <PageSpinner label={t('live.loading')} />

  const model = liveMapModel(locations.data, data.live.visitors, building.id, buildings, language)
  const context: ChipContext = { now, answeredAt: data.answeredAt, simulatedShown, onOpen: (visitId) => setPanel({ visitId, open: true }) }
  // The answer is the whole company's (F16-36): nobody in it is nobody inside, whatever the building shown.
  const nobody = data.live.visitors.length === 0
  const opened = openVisitId === null ? null : (data.live.visitors.find((visitor) => visitor.visit.id === openVisitId) ?? null)

  return (
    <div className="flex flex-col gap-4">
      {buildings.length > 1 && (
        <div className="max-w-xs">
          <Field label={t('live.building')}>
            <Select value={building.id} onChange={(event) => updateParams({ [BUILDING_PARAM]: event.target.value })}>
              {buildings.map((option) => (
                <option key={option.id} value={option.id}>
                  {locationName(option, language)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      {data.live.truncated && <p className="text-meta text-fg-muted">{t('live.truncated', { count: formatCount(data.live.visitors.length) })}</p>}

      {nobody ? (
        <EmptyState icon={Users} title={t('live.empty.nobody')} />
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_19rem]">
          <div role="region" aria-label={t('live.floorsOf', { name: locationName(building, language) })} className="flex min-w-0 flex-col gap-4">
            {model.floors.map((band) => (
              <FloorBandView key={band.floor.id} band={band} context={context} />
            ))}
          </div>
          <aside className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-8">
            <section aria-labelledby={noLocationId} data-no-location="" className="rounded-card border border-border bg-surface">
              <header className="flex items-center gap-2.5 border-b border-border-subtle px-4 py-3">
                <Layers aria-hidden="true" className="size-4 text-fg-muted" />
                <h2 id={noLocationId} className="text-section font-bold text-fg">
                  {t('live.noLocation')}
                </h2>
                <span className="ms-auto font-numeric text-sm font-semibold text-fg-secondary tabular-nums">{formatCount(model.noLocation.length)}</span>
              </header>
              <div className="p-3">
                {model.noLocation.length > 0 ? <ul className="flex flex-wrap gap-2">{chips(model.noLocation, context)}</ul> : <p className="px-1 text-sm text-fg-muted">{t('live.visitors', { count: 0, formatted: formatCount(0) })}</p>}
              </div>
            </section>
            <p data-not-tracked={model.notTracked} className="flex items-center gap-2.5 rounded-card border border-border bg-surface px-4 py-3 text-sm font-semibold text-fg">
              <UserX aria-hidden="true" className="size-4 text-fg-muted" />
              <span>{t('live.notTracked')}</span>
              <span className="ms-auto font-numeric text-fg-secondary tabular-nums">{formatCount(model.notTracked)}</span>
            </p>
          </aside>
        </div>
      )}

      {openVisitId !== null && <LiveVisitorPanel visitId={openVisitId} visitor={opened} me={me} now={now} answeredAt={data.answeredAt} simulatedShown={simulatedShown} onClose={() => setPanel({ visitId: openVisitId, open: false })} />}
    </div>
  )
}

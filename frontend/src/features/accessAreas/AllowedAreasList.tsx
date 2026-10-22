import { Layers, MapPinned } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../components/ui/Badge'
import { cn } from '../../utils/cn'
import { LocationPath } from '../journey/LocationPath'
import type { AccessAreas } from '../journey/types'
import { ZoneAccessBadge } from '../journey/ZoneAccessBadge'

export interface AllowedAreasListProps {
  areas: AccessAreas
  /** `floors`: the floors only (an alert's card); `all` (default): the floors and the extra zones. */
  show?: 'all' | 'floors'
  className?: string
}

/**
 * A visit's allowed areas as facts (Phase 16): each floor, then each extra zone as floor › zone with its
 * access level when restricted or common; an archived place marked. «غير محددة» / "Not set" when there is
 * none. The building is named only when the areas span several.
 */
export function AllowedAreasList({ areas, show = 'all', className }: AllowedAreasListProps) {
  const { t } = useTranslation('journey')
  const zones = show === 'all' ? areas.zones : []
  if (areas.floors.length === 0 && zones.length === 0) {
    return (
      <p data-areas-not-set="" className={cn('text-sm text-fg-muted', className)}>
        {t('areas.notSet')}
      </p>
    )
  }
  const buildings = new Set([...areas.floors.map((floor) => floor.building.id), ...zones.map((zone) => zone.building.id)])
  const withBuilding = buildings.size > 1
  return (
    <ul data-allowed-areas="" className={cn('flex flex-col gap-1.5 text-sm text-fg', className)}>
      {areas.floors.map((floor) => (
        <li key={`floor-${floor.id}`} data-allowed-floor={floor.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Layers aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
          <LocationPath places={withBuilding ? [floor.building, floor] : [floor]} className="font-medium" />
          {!floor.is_active && <Badge tone="neutral">{t('areas.archived')}</Badge>}
        </li>
      ))}
      {zones.map((zone) => (
        <li key={`zone-${zone.id}`} data-allowed-zone={zone.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <MapPinned aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
          <LocationPath places={withBuilding ? [zone.building, zone.floor, zone] : [zone.floor, zone]} className="font-medium" />
          <ZoneAccessBadge access={zone.access} />
          {!zone.is_active && <Badge tone="neutral">{t('areas.archived')}</Badge>}
        </li>
      ))}
    </ul>
  )
}

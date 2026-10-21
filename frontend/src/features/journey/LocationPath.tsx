import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../utils/cn'
import { useLocationName, type LocationNames } from './locationNames'

/**
 * "Floor 3 › Lobby": the places from the largest to the smallest, each in its own bidirectional
 * isolate (an English zone in the Arabic UI keeps its place), the chevron pointing the reading
 * direction's way (mirrored in Arabic). Each chevron goes with the name after it, so a wrapped path
 * never ends a line with one (F15-37). Assistive technology reads "Floor 3, Lobby": the chevron is
 * decorative and a comma, visually hidden, stands in for it.
 */
export function LocationPath({ places, className }: { places: readonly (LocationNames | null | undefined)[]; className?: string }) {
  const { t } = useTranslation('journey')
  const name = useLocationName()
  const shown = places.filter((place): place is LocationNames => Boolean(place))
  return (
    <span data-location-path="" className={cn('inline-flex min-w-0 flex-wrap items-center gap-x-1', className)}>
      {shown.map((place, index) =>
        index === 0 ? (
          <bdi key={index} className="min-w-0 break-words">
            {name(place)}
          </bdi>
        ) : (
          <span key={index} className="inline-flex min-w-0 items-center gap-x-1">
            <ChevronRight aria-hidden="true" className="mirror-rtl size-4 shrink-0 text-fg-muted" />
            <span className="sr-only">{t('locationSeparator')}</span>
            <bdi className="min-w-0 break-words">{name(place)}</bdi>
          </span>
        ),
      )}
    </span>
  )
}

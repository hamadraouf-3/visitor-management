import { useTranslation } from 'react-i18next'
import { Badge } from '../../components/ui/Badge'
import type { ZoneAccess } from '../../types/api'
import { ZONE_ACCESS_META } from './zoneAccess'

/**
 * A zone's access level as a chip: an icon and a short word on its tone. `always`: also the default level
 * (standard), where only the exceptions are marked otherwise (the map, an allowed zone).
 */
export function ZoneAccessBadge({ access, always = false, className }: { access: ZoneAccess; always?: boolean; className?: string }) {
  // Re-renders on a language switch: the label is read from the catalog.
  useTranslation('journey')
  const meta = ZONE_ACCESS_META[access]
  if (!meta.marked && !always) return null
  return (
    <span data-zone-access={access} className="inline-flex max-w-full">
      <Badge tone={meta.tone} icon={meta.icon} className={className}>
        {meta.label}
      </Badge>
    </span>
  )
}

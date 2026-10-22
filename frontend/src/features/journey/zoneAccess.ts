import { DoorOpen, LayoutGrid, Lock, type LucideIcon } from 'lucide-react'
import type { Tone } from '../../components/ui/tones'
import { i18n } from '../../i18n'
import type { ZoneAccess } from '../../types/api'

/*
 * A zone's access level (Phase 16): who may be in it. Its words, tone and symbol, as the map, the allowed
 * areas, the locations editor and the alerts show it. Restricted is amber (attention), never the alerts'
 * red: a restricted zone is a fact about a place, an alert is about a person.
 */

export interface ZoneAccessMeta {
  /** In the UI language, read when rendered. */
  readonly label: string
  readonly tone: Tone
  readonly icon: LucideIcon
  /** Marked wherever a zone is named (the map's tiles, an allowed zone); standard, the default, is not. */
  readonly marked: boolean
}

function meta(access: ZoneAccess, tone: Tone, icon: LucideIcon, marked: boolean): ZoneAccessMeta {
  return {
    get label() {
      return i18n.t(`journey:zoneAccess.${access}`)
    },
    tone,
    icon,
    marked,
  }
}

export const ZONE_ACCESS_META: Readonly<Record<ZoneAccess, ZoneAccessMeta>> = {
  COMMON: meta('COMMON', 'info', DoorOpen, true),
  STANDARD: meta('STANDARD', 'neutral', LayoutGrid, false),
  RESTRICTED: meta('RESTRICTED', 'warning', Lock, true),
}

/** The levels in the order the editor offers them: the default first. */
export const ZONE_ACCESS_LEVELS: readonly ZoneAccess[] = ['STANDARD', 'COMMON', 'RESTRICTED']

export function isZoneAccess(value: string | null | undefined): value is ZoneAccess {
  return typeof value === 'string' && (ZONE_ACCESS_LEVELS as readonly string[]).includes(value)
}

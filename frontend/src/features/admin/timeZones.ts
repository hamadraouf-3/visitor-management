import { currentLanguage, type Language } from '../../i18n'
import { ARABIC_TIME_ZONE_PLACES } from '../../i18n/timeZonePlaces'
import { formatShortUtcOffset, type DateInput } from '../../utils/datetime'
import { findMatch } from '../../utils/highlight'

/** The place a zone is named after ("America/Los_Angeles" → "Los Angeles"), or '' for zones without one. */
function placeOf(zone: string): string {
  const slash = zone.lastIndexOf('/')
  return slash >= 0 && !zone.startsWith('Etc/') ? zone.slice(slash + 1).replaceAll('_', ' ') : ''
}

/**
 * Used only where `Intl.supportedValuesOf` is missing (browsers before 2022, outside the
 * supported set of §10, or a restricted runtime): the zones of the main business regions.
 * The server validates every name against its own time zone database either way.
 */
export const FALLBACK_TIME_ZONES: readonly string[] = [
  'UTC',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'Africa/Nairobi',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Sao_Paulo',
  'America/Toronto',
  'Asia/Amman',
  'Asia/Baghdad',
  'Asia/Bangkok',
  'Asia/Beirut',
  'Asia/Dubai',
  'Asia/Hong_Kong',
  'Asia/Jerusalem',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Kuwait',
  'Asia/Qatar',
  'Asia/Riyadh',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Europe/Istanbul',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Moscow',
  'Europe/Paris',
  'Europe/Rome',
  'Pacific/Auckland',
]

type SupportedValuesOf = (key: 'timeZone') => string[]

function supportedTimeZones(): readonly string[] | null {
  const supportedValuesOf = (Intl as { supportedValuesOf?: SupportedValuesOf }).supportedValuesOf
  if (typeof supportedValuesOf !== 'function') return null
  try {
    const zones = supportedValuesOf('timeZone')
    return zones.length > 0 ? zones : null
  } catch {
    return null
  }
}

/**
 * Every IANA time zone the browser knows (`Intl.supportedValuesOf('timeZone')`), with a fixed
 * list as the fallback, plus UTC and the current setting (an engine may leave either out),
 * sorted by name.
 */
export function listTimeZones(current: string | null = null, available: readonly string[] | null = supportedTimeZones()): string[] {
  const zones = new Set(available ?? FALLBACK_TIME_ZONES)
  zones.add('UTC')
  if (current) zones.add(current)
  return [...zones].toSorted((a, b) => a.localeCompare(b))
}

/**
 * Zones matching typed text, ignoring case, accents and underscores ("new york" finds
 * America/New_York), and by the Arabic name of their place («عمّان» finds Asia/Amman); an
 * empty query lists them all.
 */
export function filterTimeZones(zones: readonly string[], query: string): string[] {
  const term = query.trim().replaceAll('_', ' ')
  if (!term) return [...zones]
  return zones.filter((zone) => {
    if (findMatch(zone.replaceAll('_', ' '), term) !== null) return true
    const arabicPlace = ARABIC_TIME_ZONE_PLACES[placeOf(zone)]
    return arabicPlace !== undefined && findMatch(arabicPlace, term) !== null
  })
}

/**
 * A zone as people read it, with its IANA name kept for those who know it:
 * "Los Angeles — America/Los_Angeles (UTC-7)". Zones without a place show their name and
 * offset ("Etc/GMT+5 (UTC-5)"), and UTC alone. The rest of the app names the zone by place
 * ("Los Angeles time (UTC-7)", `formatTimeZoneName`).
 */
export function timeZoneLabel(zone: string, at: DateInput, language: Language = currentLanguage()): string {
  const offset = formatShortUtcOffset(zone, at)
  const englishPlace = placeOf(zone)
  // In Arabic the place in Arabic where it has a name (as the app names the zone elsewhere).
  const place = language === 'ar' ? (ARABIC_TIME_ZONE_PLACES[englishPlace] ?? englishPlace) : englishPlace
  if (place) return `${place} — ${zone} (${offset})`
  return zone === offset ? zone : `${zone} (${offset})`
}

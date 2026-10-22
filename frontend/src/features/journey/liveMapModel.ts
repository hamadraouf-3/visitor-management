import type { Language } from '../../i18n'
import type { JourneyState, LocationTree, ZoneAccess } from '../../types/api'
import { compareLocationNames, type LocationNames } from './locationNames'
import type { LiveVisitor } from './types'

/*
 * The live map (Phase 16), the pure part: where each visitor inside now is drawn. Only the server's confirmed
 * place is used (`last_location`): the map never derives one. A visitor is placed in a zone of a floor of the
 * chosen building, listed under «بدون موقع» / "No location" while tracked without a usable place, or counted
 * under «غير متتبَّع» / "Not tracked".
 */

export type LivePlacement = 'placed' | 'noLocation' | 'notTracked'

/**
 * - Not tracked: never started (NOT_ENROLLED), stopped or expired (ENDED), or tracking is off (DISABLED): a
 *   place it once had is history, not where the visitor is.
 * - No location: starting (PENDING), the provider not connected (UNAVAILABLE: its last place cannot be relied
 *   on), or no confirmed place (UNCERTAIN, or ACTIVE right after the start).
 * - Placed: ACTIVE, STALE (drawn as not recent) or UNCERTAIN with a confirmed place.
 */
export function livePlacement(visitor: Pick<LiveVisitor, 'state' | 'last_location'>): LivePlacement {
  const state: JourneyState = visitor.state
  if (state === 'NOT_ENROLLED' || state === 'ENDED' || state === 'DISABLED') return 'notTracked'
  if (state === 'PENDING' || state === 'UNAVAILABLE' || visitor.last_location === null) return 'noLocation'
  return 'placed'
}

interface Named extends LocationNames {
  id: string
}

export interface ZoneTile {
  zone: Named & { access: ZoneAccess }
  visitors: LiveVisitor[]
  /** Not among the active zones any more (archived since the visitor was seen there): drawn all the same. */
  archived: boolean
}

export interface FloorBand {
  floor: Named & { level: number }
  /**
   * Set for a floor of another building that the map cannot show (archived, or without an active floor left):
   * its visitors are drawn on every building's map, under "building › floor", never dropped (F16-36).
   */
  building: Named | null
  zones: ZoneTile[]
  /** The visitors placed on the floor. */
  count: number
  archived: boolean
}

export interface LiveMapModel {
  /** The building's floors, highest level first; then the floors of buildings the map cannot show, by building. */
  floors: FloorBand[]
  noLocation: LiveVisitor[]
  notTracked: number
}

/** The active buildings that have an active floor: what the map can show, in the server's order (by name). */
export function mapBuildings(tree: LocationTree | undefined): Named[] {
  return (tree?.buildings ?? []).filter((building) => building.is_active && building.floors.some((floor) => floor.is_active)).map(({ id, name, name_ar }) => ({ id, name, name_ar }))
}

/** The building the map shows: the one asked for (in the address) when it can be shown, else the first. */
export function chosenBuilding(buildings: readonly Named[], requested: string | null): Named | null {
  return buildings.find((building) => building.id === requested) ?? buildings[0] ?? null
}

/** Alerts first (someone must look), then by name as the language sorts. */
function byAttention(language: Language): (a: LiveVisitor, b: LiveVisitor) => number {
  const collator = new Intl.Collator(language, { sensitivity: 'base', numeric: true })
  return (a, b) => Number(b.alert !== null) - Number(a.alert !== null) || collator.compare(a.visit.visitor.full_name, b.visit.visitor.full_name)
}

/**
 * The map of one building: its active floors (highest first), each with its active zones as tiles (the
 * server's order), and the visitors placed in them; a visitor seen in a zone or on a floor archived since is
 * drawn in a tile of its own, never dropped. The answer holds the whole company (F16-36): a visitor placed in
 * another building the map shows (`mapped`, from {@link mapBuildings}) is drawn on that building's map, one
 * placed in a building it cannot show (archived, or without an active floor) on every building's map, in a band
 * of its own. "No location" and "Not tracked" are the company's.
 */
export function liveMapModel(
  tree: LocationTree | undefined,
  visitors: readonly LiveVisitor[],
  buildingId: string | null,
  mapped: readonly Pick<Named, 'id'>[],
  language: Language,
): LiveMapModel {
  const building = tree?.buildings.find((candidate) => candidate.id === buildingId)
  const shownBuildings = new Set(mapped.map((candidate) => candidate.id))
  const bands = new Map<string, FloorBand>()
  for (const floor of building?.floors ?? []) {
    if (!floor.is_active) continue
    bands.set(floor.id, {
      floor: { id: floor.id, name: floor.name, name_ar: floor.name_ar, level: floor.level },
      building: null,
      zones: floor.zones.filter((zone) => zone.is_active).map((zone) => ({ zone: { id: zone.id, name: zone.name, name_ar: zone.name_ar, access: zone.access }, visitors: [], archived: false })),
      count: 0,
      archived: false,
    })
  }

  const noLocation: LiveVisitor[] = []
  let notTracked = 0
  for (const visitor of visitors) {
    const placement = livePlacement(visitor)
    if (placement === 'notTracked') {
      notTracked += 1
      continue
    }
    const location = visitor.last_location
    if (placement === 'noLocation' || location === null) {
      noLocation.push(visitor)
      continue
    }
    const here = location.building.id === buildingId
    // Drawn on its own building's map.
    if (!here && shownBuildings.has(location.building.id)) continue
    let band = bands.get(location.floor.id)
    if (!band) {
      band = { floor: { ...location.floor }, building: here ? null : { ...location.building }, zones: [], count: 0, archived: true }
      bands.set(location.floor.id, band)
    }
    let tile = band.zones.find((candidate) => candidate.zone.id === location.zone.id)
    if (!tile) {
      tile = { zone: { ...location.zone }, visitors: [], archived: true }
      band.zones.push(tile)
    }
    tile.visitors.push(visitor)
    band.count += 1
  }

  const order = byAttention(language)
  const byName = compareLocationNames(language)
  const floors = [...bands.values()].toSorted(
    (a, b) =>
      Number(a.building !== null) - Number(b.building !== null) ||
      (a.building && b.building ? byName(a.building, b.building) || a.building.id.localeCompare(b.building.id) : 0) ||
      b.floor.level - a.floor.level ||
      byName(a.floor, b.floor),
  )
  for (const band of floors) for (const tile of band.zones) tile.visitors.sort(order)
  return { floors, noLocation: noLocation.toSorted(order), notTracked }
}

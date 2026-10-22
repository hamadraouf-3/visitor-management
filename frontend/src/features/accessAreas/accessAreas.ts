import type { Department, LocationTree, VisitAccessAreasInput, ZoneAccess } from '../../types/api'
import type { Language } from '../../i18n'
import type { AccessAreas } from '../journey/types'
import { locationName, type LocationNames } from '../journey/locationNames'

/*
 * A visit's allowed areas (Phase 16), the pure part: what the picker offers (the company's active floors by
 * building, and its active zones), what it holds (the floors' and the zones' ids), a department's default, and
 * the request. The server has the final word (contract §A and §C): these only spare a refused request.
 */

/** What the picker holds: the allowed floors and the extra zones, by id. Both empty: not set. */
export interface AreaSelection {
  floorIds: readonly string[]
  zoneIds: readonly string[]
}

export const EMPTY_SELECTION: AreaSelection = { floorIds: [], zoneIds: [] }

/** The server's limit of each list. */
export const MAX_AREAS = 50

interface Named extends LocationNames {
  id: string
}

export interface FloorOption extends Named {
  level: number
  building: Named
}

export interface BuildingFloors {
  building: Named
  /** By level, ground first (the server's order). */
  floors: FloorOption[]
}

export interface ZoneOption extends Named {
  access: ZoneAccess
  floor: Named & { level: number }
  building: Named
}

export interface AreaOptions {
  /** The active buildings that have active floors, in the server's order (by name). */
  buildings: BuildingFloors[]
  /** Every active zone of an active floor, by building, floor level, then the server's order (by name). */
  zones: ZoneOption[]
}

const named = ({ id, name, name_ar }: Named): Named => ({ id, name, name_ar })

/** The active places of the company: what can be allowed. An archived place cannot (the server refuses it). */
export function areaOptions(tree: LocationTree | undefined): AreaOptions {
  const buildings: BuildingFloors[] = []
  const zones: ZoneOption[] = []
  for (const building of tree?.buildings ?? []) {
    if (!building.is_active) continue
    const floors = building.floors.filter((floor) => floor.is_active)
    if (floors.length === 0) continue
    buildings.push({ building: named(building), floors: floors.map((floor) => ({ ...named(floor), level: floor.level, building: named(building) })) })
    for (const floor of floors) {
      for (const zone of floor.zones) {
        if (zone.is_active) zones.push({ ...named(zone), access: zone.access, floor: { ...named(floor), level: floor.level }, building: named(building) })
      }
    }
  }
  return { buildings, zones }
}

/** The company has a floor to allow: the forms show the field only then. */
export function hasFloors(options: AreaOptions): boolean {
  return options.buildings.length > 0
}

/**
 * What the picker starts from for a visit's current areas. Only the active places: an archived one can no
 * longer be allowed (the server would refuse the whole change), and nothing is observed there any more.
 */
export function selectionOf(areas: AccessAreas): AreaSelection {
  return {
    floorIds: areas.floors.filter((floor) => floor.is_active).map((floor) => floor.id),
    zoneIds: areas.zones.filter((zone) => zone.is_active).map((zone) => zone.id),
  }
}

/** A visit's areas as they are, archived places included: what a change is compared with (F16-42). */
export function currentSelection(areas: AccessAreas): AreaSelection {
  return { floorIds: areas.floors.map((floor) => floor.id), zoneIds: areas.zones.map((zone) => zone.id) }
}

/**
 * The part of a selection the picker still offers: a place archived (or removed) since it was chosen is shown
 * nowhere, so it is not sent either; the server would refuse the whole request for it (F16-43).
 */
export function offeredSelection(selection: AreaSelection, options: AreaOptions): AreaSelection {
  const floors = new Set(options.buildings.flatMap((group) => group.floors.map((floor) => floor.id)))
  const zones = new Set(options.zones.map((zone) => zone.id))
  const floorIds = selection.floorIds.filter((id) => floors.has(id))
  const zoneIds = selection.zoneIds.filter((id) => zones.has(id))
  return floorIds.length === selection.floorIds.length && zoneIds.length === selection.zoneIds.length ? selection : { floorIds, zoneIds }
}

/** The areas set (some floor or zone), not "not set". */
export function isSelectionSet(selection: AreaSelection): boolean {
  return selection.floorIds.length > 0 || selection.zoneIds.length > 0
}

export function isAreasSet(areas: AccessAreas): boolean {
  return areas.floors.length > 0 || areas.zones.length > 0
}

function sameIds(x: readonly string[], y: readonly string[]): boolean {
  const a = new Set(x)
  const b = new Set(y)
  return a.size === b.size && [...a].every((id) => b.has(id))
}

/** The same floors and zones, in any order. */
export function sameSelection(a: AreaSelection, b: AreaSelection): boolean {
  return sameIds(a.floorIds, b.floorIds) && sameIds(a.zoneIds, b.zoneIds)
}

/** The request body: each id once. */
export function toAreasInput(selection: AreaSelection): VisitAccessAreasInput {
  return { floor_ids: [...new Set(selection.floorIds)], zone_ids: [...new Set(selection.zoneIds)] }
}

/**
 * A new visit's default (contract §A): the department's floor, when it has one that can still be allowed (an
 * archived floor is skipped, as the server does); else nothing.
 */
export function departmentSelection(department: Pick<Department, 'floor'> | null | undefined, options: AreaOptions): AreaSelection {
  const floor = department?.floor
  if (!floor?.is_active) return EMPTY_SELECTION
  const offered = options.buildings.some((group) => group.floors.some((option) => option.id === floor.id))
  return offered ? { floorIds: [floor.id], zoneIds: [] } : EMPTY_SELECTION
}

export function toggleFloor(selection: AreaSelection, floorId: string, checked: boolean): AreaSelection {
  const without = selection.floorIds.filter((id) => id !== floorId)
  return { ...selection, floorIds: checked ? [...without, floorId] : without }
}

export function addZone(selection: AreaSelection, zoneId: string): AreaSelection {
  return selection.zoneIds.includes(zoneId) ? selection : { ...selection, zoneIds: [...selection.zoneIds, zoneId] }
}

export function removeZone(selection: AreaSelection, zoneId: string): AreaSelection {
  return { ...selection, zoneIds: selection.zoneIds.filter((id) => id !== zoneId) }
}

/** Lower case, without Arabic diacritics and tatweel, alef forms as one: what a search compares. */
export function searchKey(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .trim()
}

/**
 * The zones the extra zones' search offers for `query`: those not chosen yet whose name (either language),
 * floor or building contains the text; all of them for an empty query.
 */
export function matchingZones(zones: readonly ZoneOption[], chosen: readonly string[], query: string): ZoneOption[] {
  const key = searchKey(query)
  const taken = new Set(chosen)
  return zones.filter((zone) => {
    if (taken.has(zone.id)) return false
    if (!key) return true
    return [zone.name, zone.name_ar, zone.floor.name, zone.floor.name_ar, zone.building.name, zone.building.name_ar].some(
      (text) => typeof text === 'string' && searchKey(text).includes(key),
    )
  })
}

/** "Floor 4 › Server room" as one line of text (the combobox's input shows it). */
export function zoneLabel(zone: ZoneOption, language: Language): string {
  return `${locationName(zone.floor, language)} › ${locationName(zone, language)}`
}

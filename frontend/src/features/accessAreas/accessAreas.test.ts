import { describe, expect, it } from 'vitest'
import { FLOOR_3, FLOOR_3_AREAS, FLOOR_4, GROUND, LOBBY, makeLocationTree, makeTower, NO_AREAS, OPEN_OFFICE, SERVER_ROOM, TOWER } from '../journey/testRoutes'
import {
  addZone,
  areaOptions,
  departmentSelection,
  EMPTY_SELECTION,
  hasFloors,
  isSelectionSet,
  matchingZones,
  removeZone,
  sameSelection,
  searchKey,
  selectionOf,
  toAreasInput,
  toggleFloor,
  zoneLabel,
} from './accessAreas'

const departmentOn = (floor: { id: string; is_active: boolean } | null) => ({
  floor: floor && { ...FLOOR_3, ...floor, building: TOWER },
})

describe('what the allowed areas’ picker offers', () => {
  it('the active floors by building in level order, and every active zone of them', () => {
    const tower = makeTower()
    tower.floors[1]!.zones[1]!.is_active = false
    const options = areaOptions(makeLocationTree([tower]))
    expect(options.buildings).toHaveLength(1)
    expect(options.buildings[0]!.floors.map((floor) => floor.id)).toEqual([GROUND.id, FLOOR_3.id, FLOOR_4.id])
    expect(options.zones.map((zone) => zone.id)).not.toContain(tower.floors[1]!.zones[1]!.id)
    expect(options.zones.find((zone) => zone.id === SERVER_ROOM.id)).toMatchObject({ access: 'RESTRICTED', floor: { id: FLOOR_4.id, level: 4 }, building: { id: TOWER.id } })
    expect(hasFloors(options)).toBe(true)
  })

  it('nothing of an archived building or floor', () => {
    const archivedFloor = makeTower()
    archivedFloor.floors[2]!.is_active = false
    expect(areaOptions(makeLocationTree([archivedFloor])).zones.map((zone) => zone.id)).not.toContain(OPEN_OFFICE.id)
    const archivedBuilding = { ...makeTower(), is_active: false }
    expect(hasFloors(areaOptions(makeLocationTree([archivedBuilding])))).toBe(false)
    expect(hasFloors(areaOptions(undefined))).toBe(false)
  })
})

describe('what the picker holds', () => {
  const options = areaOptions(makeLocationTree())

  it('starts from a department’s floor, unless it is archived or not offered', () => {
    expect(departmentSelection(departmentOn({ id: FLOOR_3.id, is_active: true }), options)).toEqual({ floorIds: [FLOOR_3.id], zoneIds: [] })
    expect(departmentSelection(departmentOn({ id: FLOOR_3.id, is_active: false }), options)).toEqual(EMPTY_SELECTION)
    expect(departmentSelection(departmentOn({ id: 'gone', is_active: true }), options)).toEqual(EMPTY_SELECTION)
    expect(departmentSelection(departmentOn(null), options)).toEqual(EMPTY_SELECTION)
    expect(departmentSelection(undefined, options)).toEqual(EMPTY_SELECTION)
  })

  it('starts from a visit’s active areas only', () => {
    const areas = {
      floors: [...FLOOR_3_AREAS.floors, { ...FLOOR_4, building: TOWER, is_active: false }],
      zones: [{ ...SERVER_ROOM, floor: FLOOR_4, building: TOWER, is_active: true }],
    }
    expect(selectionOf(areas)).toEqual({ floorIds: [FLOOR_3.id], zoneIds: [SERVER_ROOM.id] })
    expect(isSelectionSet(selectionOf(NO_AREAS))).toBe(false)
  })

  it('turns floors on and off and adds and removes zones, each once', () => {
    let selection = toggleFloor(EMPTY_SELECTION, FLOOR_3.id, true)
    selection = toggleFloor(selection, FLOOR_3.id, true)
    selection = addZone(addZone(selection, SERVER_ROOM.id), SERVER_ROOM.id)
    expect(selection).toEqual({ floorIds: [FLOOR_3.id], zoneIds: [SERVER_ROOM.id] })
    expect(removeZone(toggleFloor(selection, FLOOR_3.id, false), SERVER_ROOM.id)).toEqual(EMPTY_SELECTION)
  })

  it('sends each id once, and knows the same sets in another order', () => {
    expect(toAreasInput({ floorIds: [FLOOR_3.id, FLOOR_3.id], zoneIds: [LOBBY.id] })).toEqual({ floor_ids: [FLOOR_3.id], zone_ids: [LOBBY.id] })
    expect(sameSelection({ floorIds: [GROUND.id, FLOOR_3.id], zoneIds: [] }, { floorIds: [FLOOR_3.id, GROUND.id], zoneIds: [] })).toBe(true)
    expect(sameSelection({ floorIds: [GROUND.id], zoneIds: [] }, { floorIds: [GROUND.id], zoneIds: [LOBBY.id] })).toBe(false)
    expect(sameSelection({ floorIds: [GROUND.id, GROUND.id], zoneIds: [] }, { floorIds: [GROUND.id, FLOOR_3.id], zoneIds: [] })).toBe(false)
  })
})

describe('the extra zones’ search', () => {
  const { zones } = areaOptions(makeLocationTree())

  it('matches a zone’s names in either language, its floor and its building, leaving out the chosen ones', () => {
    expect(matchingZones(zones, [], 'server').map((zone) => zone.id)).toEqual([SERVER_ROOM.id])
    expect(matchingZones(zones, [], 'خوادم').map((zone) => zone.id)).toEqual([SERVER_ROOM.id])
    expect(matchingZones(zones, [], 'floor 4').map((zone) => zone.id)).toEqual([OPEN_OFFICE.id, SERVER_ROOM.id])
    expect(matchingZones(zones, [OPEN_OFFICE.id], 'floor 4').map((zone) => zone.id)).toEqual([SERVER_ROOM.id])
    expect(matchingZones(zones, [], '')).toHaveLength(zones.length)
  })

  it('compares without case, Arabic diacritics or alef forms', () => {
    expect(searchKey('  Server ROOM ')).toBe('server room')
    expect(searchKey('إستقبال')).toBe(searchKey('استقبال'))
    expect(searchKey('غُرفة')).toBe('غرفة')
  })

  it('names a zone with its floor', () => {
    const server = zones.find((zone) => zone.id === SERVER_ROOM.id)!
    expect(zoneLabel(server, 'en')).toBe('Floor 4 › Server room')
    expect(zoneLabel(server, 'ar')).toBe('الطابق الرابع › غرفة الخوادم')
  })
})

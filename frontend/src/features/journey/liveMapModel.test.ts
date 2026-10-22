import { describe, expect, it } from 'vitest'
import type { JourneyState } from '../../types/api'
import { chosenBuilding, liveMapModel, livePlacement, mapBuildings } from './liveMapModel'
import { FLOOR_3, FLOOR_4, FLOOR_4_PLACE, GROUND, LOBBY, makeLiveVisitor, makeLocationTree, makeTower, MEETING, OPEN_OFFICE, otherVisit, PLACE, RECEPTION_ZONE, SERVER_PLACE, SERVER_ROOM, TOWER } from './testRoutes'
import type { BuildingNode } from './types'

const ANNEX: BuildingNode = { id: 'b1000000-0000-4000-8000-000000000002', name: 'Annex', name_ar: null, is_active: true, created_at: '', updated_at: '', floors: [] }

function visitor(index: number, name: string, overrides: Parameters<typeof makeLiveVisitor>[0] = {}) {
  return makeLiveVisitor({ visit: otherVisit(index, name), ...overrides })
}

describe('the live map: where a visitor is drawn', () => {
  it.each<[JourneyState, boolean, ReturnType<typeof livePlacement>]>([
    ['ACTIVE', true, 'placed'],
    ['STALE', true, 'placed'],
    ['UNCERTAIN', true, 'placed'],
    ['UNCERTAIN', false, 'noLocation'],
    ['ACTIVE', false, 'noLocation'],
    ['PENDING', false, 'noLocation'],
    // The provider is not connected: its last place cannot be relied on (contract §D).
    ['UNAVAILABLE', true, 'noLocation'],
    ['NOT_ENROLLED', false, 'notTracked'],
    // Stopped or expired, or tracking off: a place it once had is history.
    ['ENDED', true, 'notTracked'],
    ['DISABLED', false, 'notTracked'],
  ])('%s with a place %s → %s', (state, located, placement) => {
    expect(livePlacement({ state, last_location: located ? PLACE : null })).toBe(placement)
  })
})

describe('the live map of a building', () => {
  it('stacks the active floors highest first, each with its active zones as tiles in the server’s order', () => {
    const model = liveMapModel(makeLocationTree(), [], TOWER.id, [TOWER], 'en')
    expect(model.floors.map((band) => band.floor.id)).toEqual([FLOOR_4.id, FLOOR_3.id, GROUND.id])
    expect(model.floors.map((band) => band.zones.map((tile) => tile.zone.id))).toEqual([[OPEN_OFFICE.id, SERVER_ROOM.id], [LOBBY.id, MEETING.id], [RECEPTION_ZONE.id]])
    expect(model.floors[0]!.zones[1]!.zone.access).toBe('RESTRICTED')
    expect(model).toMatchObject({ noLocation: [], notTracked: 0 })
  })

  it('puts each visitor in their zone, counts the floor, lists those without a place and counts those not tracked', () => {
    const visitors = [
      visitor(1, 'Maya Odeh'),
      visitor(2, 'Omar Saleh', { last_location: FLOOR_4_PLACE }),
      visitor(3, 'Lina Haddad', { state: 'PENDING', last_location: null }),
      visitor(4, 'Basel Nasser', { state: 'NOT_ENROLLED', last_location: null }),
      visitor(5, 'Rana Odeh', { state: 'ENDED' }),
      visitor(6, 'Sami Khalil', { state: 'UNAVAILABLE' }),
    ]
    const model = liveMapModel(makeLocationTree(), visitors, TOWER.id, [TOWER], 'en')
    const [floor4, floor3, ground] = model.floors
    expect(floor4!.zones[0]!.visitors.map((one) => one.visit.visitor.full_name)).toEqual(['Omar Saleh'])
    expect(floor3!.zones[0]!.visitors.map((one) => one.visit.visitor.full_name)).toEqual(['Maya Odeh'])
    expect([floor4!.count, floor3!.count, ground!.count]).toEqual([1, 1, 0])
    expect(model.noLocation.map((one) => one.visit.visitor.full_name)).toEqual(['Lina Haddad', 'Sami Khalil'])
    expect(model.notTracked).toBe(2)
  })

  it('lists a visitor with an alert first, then by name', () => {
    const alert = { id: 'a1', type: 'UNAUTHORIZED_AREA' as const, status: 'OPEN' as const }
    const visitors = [visitor(1, 'Zaid Amer'), visitor(2, 'Adel Fares'), visitor(3, 'Maya Odeh', { alert })]
    const tile = liveMapModel(makeLocationTree(), visitors, TOWER.id, [TOWER], 'en').floors[1]!.zones[0]!
    expect(tile.visitors.map((one) => one.visit.visitor.full_name)).toEqual(['Maya Odeh', 'Adel Fares', 'Zaid Amer'])
  })

  it('draws a visitor seen in a zone or on a floor archived since in a tile of its own, never drops them', () => {
    const tower = makeTower()
    tower.floors[2]!.zones[1]!.is_active = false
    const model = liveMapModel(makeLocationTree([tower]), [visitor(1, 'Maya Odeh', { last_location: SERVER_PLACE })], TOWER.id, [TOWER], 'en')
    const floor4 = model.floors[0]!
    expect(floor4.zones.map((tile) => [tile.zone.id, tile.archived])).toEqual([
      [OPEN_OFFICE.id, false],
      [SERVER_ROOM.id, true],
    ])
    expect(floor4.count).toBe(1)

    const withoutFloor4 = makeTower()
    withoutFloor4.floors[2]!.is_active = false
    const archivedFloor = liveMapModel(makeLocationTree([withoutFloor4]), [visitor(1, 'Maya Odeh', { last_location: SERVER_PLACE })], TOWER.id, [TOWER], 'en').floors[0]!
    expect(archivedFloor).toMatchObject({ archived: true, count: 1, floor: { id: FLOOR_4.id } })
  })

  it('leaves out a visitor placed in another building the map shows: drawn on that building’s map', () => {
    const elsewhere = { ...PLACE, building: { id: ANNEX.id, name: ANNEX.name, name_ar: null } }
    const model = liveMapModel(makeLocationTree(), [visitor(1, 'Maya Odeh', { last_location: elsewhere })], TOWER.id, [TOWER, ANNEX], 'en')
    expect(model.floors.map((band) => band.floor.id)).toEqual([FLOOR_4.id, FLOOR_3.id, GROUND.id])
    expect(model.floors.every((band) => band.count === 0)).toBe(true)
    expect(model.noLocation).toEqual([])
  })

  it('draws a visitor last seen in a building the map cannot show (archived, no active floor) on every building’s map, in a band of its own (F16-36)', () => {
    const annexPlace = { building: { id: ANNEX.id, name: ANNEX.name, name_ar: null }, floor: { ...FLOOR_3, id: 'f2000000-0000-4000-8000-000000000001', name: 'Annex lobby floor', level: 0 }, zone: { ...LOBBY, id: 'z2000000-0000-4000-8000-000000000001' } }
    const visitors = [visitor(1, 'Maya Odeh'), visitor(2, 'Omar Saleh', { state: 'STALE', last_location: annexPlace })]
    // The Annex is not among the buildings the map shows: archived, or every floor of it archived.
    const model = liveMapModel(makeLocationTree(), visitors, TOWER.id, [TOWER], 'en')
    expect(model.floors.map((band) => band.floor.id)).toEqual([FLOOR_4.id, FLOOR_3.id, GROUND.id, annexPlace.floor.id])
    expect(model.floors.at(-1)).toMatchObject({ building: { id: ANNEX.id }, archived: true, count: 1, zones: [{ zone: { id: annexPlace.zone.id }, archived: true }] })
    expect(model.floors.at(-1)!.zones[0]!.visitors.map((one) => one.visit.visitor.full_name)).toEqual(['Omar Saleh'])
    expect(model.floors.slice(0, 3).every((band) => band.building === null)).toBe(true)
  })

  it('lists "No location" and counts "Not tracked" for the whole company, whichever building is shown', () => {
    const annexPlace = { ...PLACE, building: { id: ANNEX.id, name: ANNEX.name, name_ar: null } }
    const visitors = [visitor(1, 'Maya Odeh', { state: 'UNAVAILABLE', last_location: annexPlace }), visitor(2, 'Omar Saleh', { state: 'DISABLED', last_location: annexPlace })]
    const model = liveMapModel(makeLocationTree(), visitors, TOWER.id, [TOWER, ANNEX], 'en')
    expect(model.noLocation.map((one) => one.visit.visitor.full_name)).toEqual(['Maya Odeh'])
    expect(model.notTracked).toBe(1)
  })

  it('offers the active buildings with an active floor, and shows the one asked for, else the first', () => {
    const empty = { ...ANNEX }
    const archived: BuildingNode = { ...makeTower(), id: 'b1000000-0000-4000-8000-000000000003', name: 'Old wing', is_active: false }
    const buildings = mapBuildings(makeLocationTree([makeTower(), empty, archived]))
    expect(buildings.map((building) => building.id)).toEqual([TOWER.id])
    expect(chosenBuilding(buildings, null)?.id).toBe(TOWER.id)
    expect(chosenBuilding(buildings, 'not-a-building')?.id).toBe(TOWER.id)
    expect(chosenBuilding([], null)).toBeNull()
    expect(mapBuildings(undefined)).toEqual([])
  })
})

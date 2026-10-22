import type { JourneyListItem, LiveJourneys, LocationTree, TrackingAlertSummary, Visit, VisitJourney } from '../../types/api'

/*
 * The shapes the API nests in its responses, named for the journey's components. `types/api.ts` exports
 * only what the backend's contract names at the top level (`api.contract.test.ts`); these are read from
 * the responses that carry them, so they cannot drift from it.
 */

/** A zone with its floor and building. */
export type JourneyPlace = NonNullable<VisitJourney['last_location']>
export type JourneyEvent = VisitJourney['timeline'][number]
export type JourneyAssociation = NonNullable<VisitJourney['association']>
export type BuildingNode = LocationTree['buildings'][number]
export type FloorNode = BuildingNode['floors'][number]
export type ZoneNode = FloorNode['zones'][number]

/* Phase 16 ------------------------------------------------------------------------------------------ */

/** A visit's allowed areas: its floors and its extra zones (both empty: not set). */
export type AccessAreas = Visit['access_areas']
export type AccessFloor = AccessAreas['floors'][number]
export type AccessZone = AccessAreas['zones'][number]
/** A stay of a journey's path: one zone, from when to when. */
export type JourneyStay = VisitJourney['path'][number]
/** A visitor inside now, on the live map. */
export type LiveVisitor = LiveJourneys['visitors'][number]
/** A visit's active alert, as a row or a visitor names it. */
export type AlertRef = NonNullable<JourneyListItem['alert']>
/** An open alert as the shell's summary lists it. */
export type AlertBrief = TrackingAlertSummary['latest'][number]

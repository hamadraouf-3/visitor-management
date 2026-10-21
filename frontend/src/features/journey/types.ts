import type { LocationTree, VisitJourney } from '../../types/api'

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

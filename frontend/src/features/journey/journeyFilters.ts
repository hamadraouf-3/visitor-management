import { readDateParam, type UrlParamChanges } from '../../hooks/useUrlParams'
import type { JourneyListParams, JourneyState } from '../../types/api'
import { isJourneyState } from './journeyStates'

export const JOURNEY_PAGE_SIZE = 25

/**
 * The list's view in the address: the day (`day`, company-local; none means today), the state and the
 * page. The search text (`q`) is private (`PRIVATE_PARAMS`): it is kept in the history entry's state,
 * never in the address the browser saves.
 */
export const JOURNEY_PARAM = { date: 'day', state: 'state', q: 'q', page: 'page' } as const

export interface JourneyFilters {
  /** Company-local `YYYY-MM-DD`; null: today. */
  date: string | null
  state: JourneyState | null
  q: string
}

export const EMPTY_JOURNEY_FILTERS: JourneyFilters = { date: null, state: null, q: '' }

/** The filters in the address; a malformed value (an impossible date, an unknown state) is ignored. */
export function readJourneyFilters(params: URLSearchParams): JourneyFilters {
  const state = params.get(JOURNEY_PARAM.state)
  return {
    date: readDateParam(params, JOURNEY_PARAM.date),
    state: isJourneyState(state) ? state : null,
    q: params.get(JOURNEY_PARAM.q)?.trim() ?? '',
  }
}

/** Address changes for new filters; any change returns to the first page. Today is the default day and is left out. */
export function journeyFilterChanges(filters: Partial<JourneyFilters>, today: string): UrlParamChanges {
  const changes: UrlParamChanges = { [JOURNEY_PARAM.page]: null }
  if ('date' in filters) changes[JOURNEY_PARAM.date] = filters.date && filters.date !== today ? filters.date : null
  if ('state' in filters) changes[JOURNEY_PARAM.state] = filters.state ?? null
  if ('q' in filters) changes[JOURNEY_PARAM.q] = filters.q?.trim() || null
  return changes
}

/** How many filters narrow the list (for the phone's "Filters (n)"); another day counts as one. */
export function activeJourneyFilterCount(filters: JourneyFilters, today: string): number {
  return [filters.date !== null && filters.date !== today, filters.state !== null, filters.q !== ''].filter(Boolean).length
}

/** `GET /journeys` parameters: the day (today when none), the state, the search, the page. */
export function journeyListParams(filters: JourneyFilters, page: number): JourneyListParams {
  const params: JourneyListParams = { page, page_size: JOURNEY_PAGE_SIZE }
  if (filters.date) params.day = filters.date
  if (filters.state) params.state = [filters.state]
  if (filters.q) params.q = filters.q
  return params
}

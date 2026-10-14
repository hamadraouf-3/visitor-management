import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate, type Location } from 'react-router'
import { useSessionUserId } from '../auth/useAuth'
import { PRIVATE_PARAMS } from '../paths'
import { isDateKey } from '../utils/datetime'
import { isUuid } from '../utils/ids'

/** Changes to apply to the query string: a string sets the parameter, null removes it. */
export type UrlParamChanges = Record<string, string | null>

/** Router-state key of the private part of a page's view (see `PRIVATE_PARAMS`). */
const VIEW_STATE_KEY = 'view'

interface ViewState {
  /** The user whose session wrote the values: another user's are ignored. */
  owner: string | null
  values: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPrivateParam(key: string): boolean {
  return PRIVATE_PARAMS.includes(key)
}

/** The private values in a history entry's state, if the current user wrote them. */
export function readViewValues(state: unknown, owner: string | null): Record<string, string> {
  if (!isRecord(state)) return {}
  const view = state[VIEW_STATE_KEY]
  if (!isRecord(view) || view.owner !== owner || !isRecord(view.values)) return {}
  return Object.fromEntries(
    Object.entries(view.values).filter((entry): entry is [string, string] => isPrivateParam(entry[0]) && typeof entry[1] === 'string'),
  )
}

/** `state` with its private view replaced (other parts, such as a back link, are kept). */
function withViewValues(state: unknown, owner: string | null, values: Record<string, string>): Record<string, unknown> | null {
  const next: Record<string, unknown> = isRecord(state) ? { ...state } : {}
  if (Object.keys(values).length > 0) next[VIEW_STATE_KEY] = { owner, values } satisfies ViewState
  else delete next[VIEW_STATE_KEY]
  return Object.keys(next).length > 0 ? next : null
}

type ViewLocation = Pick<Location, 'pathname' | 'search' | 'hash' | 'state'>

/**
 * The page's view parameters plus a setter that applies several changes in ONE navigation (e.g.
 * a new tab and page 1 together). Replaces the history entry, so list filters do not flood the
 * back button.
 *
 * Most parameters live in the query string, so a view can be bookmarked and shared. Private ones
 * (`PRIVATE_PARAMS`: the search text, a host's name) live in the history entry's state instead,
 * tagged with the signed-in user: the back button, a reload and a "Back to …" link still restore
 * them, but they never reach the browser's saved history, and a later user of the tab does not
 * get them. A link of an earlier version that has them in its query string still works, and
 * they are moved out of the address bar at once.
 */
export function useUrlParams(): [URLSearchParams, (changes: UrlParamChanges) => void] {
  const location = useLocation()
  const navigate = useNavigate()
  const owner = useSessionUserId()

  // The query string (with any legacy private value, until it is moved), overridden by the
  // private values this user keeps in the entry's state.
  const params = useMemo(() => {
    const merged = new URLSearchParams(location.search)
    for (const [key, value] of Object.entries(readViewValues(location.state, owner))) merged.set(key, value)
    return merged
  }, [location.search, location.state, owner])

  // Each change builds on the previous one, also before its navigation has been rendered: two
  // calls in the same tick, or a call while another render (e.g. data arriving) still shows
  // the location the previous change navigated away from.
  const latest = useRef<{ location: ViewLocation; owner: string | null }>({ location, owner })
  const renderedKey = useRef(location.key)
  const pendingFrom = useRef<string | null>(null)
  useLayoutEffect(() => {
    renderedKey.current = location.key
    if (pendingFrom.current === location.key) {
      latest.current = { ...latest.current, owner }
      return
    }
    pendingFrom.current = null
    latest.current = { location, owner }
  })

  const update = useCallback(
    (changes: UrlParamChanges) => {
      const { location: current, owner: currentOwner } = latest.current
      const search = new URLSearchParams(current.search)
      // A legacy private value still in the query string counts as chosen (until it is moved).
      const values: Record<string, string> = {}
      for (const key of PRIVATE_PARAMS) {
        const legacy = search.get(key)
        if (legacy) values[key] = legacy
        search.delete(key)
      }
      Object.assign(values, readViewValues(current.state, currentOwner))
      for (const [key, value] of Object.entries(changes)) {
        const empty = value === null || value === ''
        if (isPrivateParam(key)) {
          if (empty) delete values[key]
          else values[key] = value
        } else if (empty) search.delete(key)
        else search.set(key, value)
      }
      const query = search.toString()
      const next: ViewLocation = {
        pathname: current.pathname,
        search: query ? `?${query}` : '',
        hash: current.hash,
        state: withViewValues(current.state, currentOwner, values),
      }
      pendingFrom.current ??= renderedKey.current
      latest.current = { location: next, owner: currentOwner }
      navigate({ pathname: next.pathname, search: next.search, hash: next.hash }, { replace: true, preventScrollReset: true, state: next.state })
    },
    [navigate],
  )

  // A link of an earlier version (or typed by hand) with private values in its query string:
  // they move into the entry's state, and the address bar no longer shows them.
  useEffect(() => {
    const search = new URLSearchParams(location.search)
    if (PRIVATE_PARAMS.some((key) => search.has(key))) update({})
  }, [location.search, update])

  return [params, update]
}

/** A 1-based page number from the query (`?page=3`); anything else is page 1. */
export function readPageParam(params: URLSearchParams, key = 'page'): number {
  const raw = params.get(key)
  if (raw === null || !/^\d{1,6}$/.test(raw)) return 1
  return Math.max(1, Number(raw))
}

/** One of `allowed` from the query, or `fallback` for a missing or unknown value. */
export function readEnumParam<T extends string>(params: URLSearchParams, key: string, allowed: readonly T[], fallback: T): T {
  const raw = params.get(key)
  return raw !== null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
}

/** A company-local `YYYY-MM-DD` date from the query; null for a missing or impossible date. */
export function readDateParam(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key)
  return raw !== null && isDateKey(raw) ? raw : null
}

/** A record ID (UUID) from the query, lower-cased; null for anything else, so it is never sent. */
export function readUuidParam(params: URLSearchParams, key: string): string | null {
  const raw = params.get(key)?.trim()
  return raw && isUuid(raw) ? raw.toLowerCase() : null
}

/** The value written for a page: page 1 is the default and is left out of the URL. */
export function pageParamValue(page: number): string | null {
  return page > 1 ? String(page) : null
}

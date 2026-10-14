import { useQuery, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { getCompanySettings } from './company'
import { listDepartments } from './departments'
import { queryKeys } from './queryKeys'
import { getInside } from './reception'
import { searchHosts } from './users'
import type { HostSearchParams } from '../types/api'

/*
 * Query hooks that several features read. Each cache entry has exactly one hook, so every
 * screen that shows it fetches it with the same options and headers.
 */

/** §10: lists that change while they are on screen (reception, the evacuation list) refresh every 15 s. */
export const LIST_POLL_MS = 15_000

/** Reference data changes rarely; one load per few minutes is plenty. */
const REFERENCE_STALE_MS = 5 * 60_000

/**
 * Whether a fetch of `queryKey` is a background refresh, sent with `X-Background-Refresh: 1`
 * (§7.2) so a screen left open on a shared device still reaches the session's idle timeout.
 * Only the first load of a list, or of the session check (no data and no error yet), is the
 * user's own request; every later fetch (the poll, the session heartbeat, a refresh after a
 * mutation, a window focus) is a background refresh.
 */
export function isBackgroundFetch(client: QueryClient, queryKey: QueryKey): boolean {
  const state = client.getQueryState(queryKey)
  return Boolean(state && (state.dataUpdatedAt || state.errorUpdatedAt))
}

/**
 * Everyone checked in, any date (GET /reception/inside): the reception screen's Inside tab and
 * the evacuation list (/inside) read this one entry. Polled every 15 s while shown (TanStack
 * pauses it in a hidden tab), and `staleTime: 0`, so a list that comes back into view is
 * refetched at once: an evacuation list must never be older than it looks.
 */
export function useInsideList({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.reception.inside,
    queryFn: ({ signal, client, queryKey }) => getInside({ signal, backgroundRefresh: isBackgroundFetch(client, queryKey) }),
    refetchInterval: LIST_POLL_MS,
    staleTime: 0,
    enabled,
  })
}

/** Reloads the inside list because a person asked (Refresh, Print): a user request, not a background refresh. */
export function fetchInsideListNow(queryClient: QueryClient) {
  return queryClient.fetchQuery({
    queryKey: queryKeys.reception.inside,
    queryFn: ({ signal }) => getInside({ signal }),
    staleTime: 0,
  })
}

/** Company settings (GET /company/settings), readable by every role (`allow_walk_ins`, the settings form). */
export function useCompanySettings() {
  return useQuery({
    queryKey: queryKeys.companySettings,
    queryFn: ({ signal }) => getCompanySettings({ signal }),
  })
}

/**
 * The active host with this ID, or null when there is none. GET /users/hosts has no lookup by
 * ID, so the directory is searched by `nameHint` (its first page without one) and the result
 * matched by ID: a name is shown only as the server returns it for that ID. For a walk-in
 * pre-filled from a scanned visit, and the history's host filter opened from a link. A host
 * renamed since, or no longer a host, is not found.
 */
export function useHostById(host: { id: string; nameHint: string | null } | null) {
  const params: HostSearchParams = host?.nameHint ? { q: host.nameHint } : {}
  return useQuery({
    queryKey: queryKeys.users.hosts(params),
    queryFn: ({ signal }) => searchHosts(params, { signal }),
    enabled: host !== null,
    select: (hosts) => hosts.find((candidate) => candidate.id === host?.id) ?? null,
  })
}

/** The active departments (GET /departments), for every department picker. */
export function useActiveDepartments() {
  return useQuery({
    queryKey: queryKeys.departments.list(),
    queryFn: ({ signal }) => listDepartments({}, { signal }),
    staleTime: REFERENCE_STALE_MS,
  })
}

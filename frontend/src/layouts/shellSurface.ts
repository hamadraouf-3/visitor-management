import { useMatches } from 'react-router'
import { useAppearance } from '../appearance/useAppearance'

/** The surface a screen inside the app layout is drawn on. */
export type ShellSurface = 'light' | 'dark'

/**
 * A route's `handle` as the app layout reads it. A screen that is dark from edge to edge (the
 * reception tablet of direction C) declares it on its route:
 *
 *   { path: 'reception', handle: DARK_SURFACE_HANDLE, lazy: … }
 *
 * The layout then draws the shell in its deep teal and puts `data-surface="dark"` on its root, so
 * the page, and everything it opens on top of itself (dialogs, toasts, the drawer), takes the dark
 * tokens (`index.css`). The deepest route that says something wins.
 *
 * Such a screen is dark by design, in either colour scheme, as long as the device leaves the choice to
 * the device (System) or chose Dark. A device that chose Light gets it light (Phase 13): a person who
 * picks Light and opens the reception must see the choice there too.
 */
export interface ShellRouteHandle {
  surface?: ShellSurface
}

export const DARK_SURFACE_HANDLE: ShellRouteHandle = { surface: 'dark' }

function surfaceOf(handle: unknown): ShellSurface | undefined {
  if (typeof handle !== 'object' || handle === null || !('surface' in handle)) return undefined
  const { surface } = handle as { surface: unknown }
  return surface === 'dark' || surface === 'light' ? surface : undefined
}

/** The surface the current route asks for: the deepest route's `handle.surface`, else light. */
function routeSurface(matches: ReturnType<typeof useMatches>): ShellSurface {
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const surface = surfaceOf(matches[index]?.handle)
    if (surface) return surface
  }
  return 'light'
}

/** The surface the current screen is drawn on: the route's, unless the device chose Light. */
export function useShellSurface(): ShellSurface {
  const matches = useMatches()
  const appearance = useAppearance()
  return appearance === 'light' ? 'light' : routeSurface(matches)
}

import type { RouteObject } from 'react-router'
import { routes } from '../router'

/**
 * The app's route tree for tests that render the whole app, with every lazy page module
 * already loaded.
 *
 * Most pages are lazy routes (separate chunks in the build). In a test the first navigation
 * into one would import, and on a cold cache transform, the page's module tree inside a
 * `findBy` wait; on a loaded machine that can outlast the wait. Loading them here, while the
 * test file is collected, keeps those waits about the page. Each router still calls `lazy`,
 * which then resolves from the module cache at once.
 */
async function loadLazyRoutes(tree: readonly RouteObject[]): Promise<void> {
  await Promise.all(
    tree.map(async (route) => {
      const { lazy } = route
      if (typeof lazy === 'function') await lazy()
      else if (lazy) await Promise.all(Object.values(lazy).map((load: unknown) => (typeof load === 'function' ? load() : undefined)))
      if (route.children) await loadLazyRoutes(route.children)
    }),
  )
}

await loadLazyRoutes(routes)

export { routes }

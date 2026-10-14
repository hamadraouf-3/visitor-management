import { jsonResponse, type RouteHandler } from '../../test/api'
import { page } from '../../test/fixtures'
import type { Visit } from '../../types/api'

/**
 * API routes /history needs, with an empty result, for tests that only land on the page (route
 * guards, navigation). Spread into `mockApi({...})`.
 */
export function historyRoutes(visits: Visit[] = []): Record<string, RouteHandler> {
  return { 'GET /visits': () => jsonResponse(page(visits)) }
}

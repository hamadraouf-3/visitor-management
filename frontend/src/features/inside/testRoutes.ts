import { jsonResponse, type RouteHandler } from '../../test/api'
import { makeInsideVisit } from '../../test/fixtures'
import type { InsideList, InsideVisit, Visit } from '../../types/api'

/** API routes /inside needs (everyone inside), for tests that land on the page. Spread into `mockApi({...})`. */
export function insideRoutes(visits: (Visit | InsideVisit)[] = []): Record<string, RouteHandler> {
  const items = visits.map((visit) => ('phone' in visit.visitor ? (visit as InsideVisit) : makeInsideVisit(visit)))
  const body: InsideList = { count: items.length, items }
  return { 'GET /reception/inside': () => jsonResponse(body) }
}

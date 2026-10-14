import { vi } from 'vitest'
import { EMPTY_BRAND } from '../identity/brand'
import type { Me, Role } from '../types/api'

export interface RecordedRequest {
  method: string
  /** Path below /api/v1, without the query string. */
  path: string
  url: URL
  headers: Headers
  /** The parsed JSON body; a body sent as it is (the PNG of a logo) is the `Blob` itself. */
  body: unknown
}

type RouteResult = Response | Promise<Response>
export type RouteHandler = (request: RecordedRequest) => RouteResult

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

export function errorResponse(status: number, code: string, message: string, details: Record<string, unknown> = {}): Response {
  return jsonResponse({ error: { code, message, details }, request_id: 'req-test-1' }, status)
}

export function noContent(): Response {
  return new Response(null, { status: 204 })
}

/**
 * Requests no route handled since the last check. The rejected fetch alone is not enough:
 * the API client turns it into a NETWORK_ERROR that the UI may swallow, so the test setup
 * fails the test after it ends (`assertNoUnhandledRequests`).
 */
const unhandledRequests: string[] = []

/** Throws (and resets) when any request reached `mockApi` without a matching route. */
export function assertNoUnhandledRequests(): void {
  const unhandled = unhandledRequests.splice(0)
  if (unhandled.length === 0) return
  throw new Error(
    `Unhandled request(s) in this test; add a mockApi route or remove the call:\n${unhandled.map((request) => `  ${request}`).join('\n')}`,
  )
}

/**
 * Replaces `fetch` with a router keyed by "METHOD /path" (path below /api/v1). An unhandled
 * request rejects and fails the test (see `assertNoUnhandledRequests`). Returns the recorded
 * requests for assertions.
 */
export function mockApi(routes: Record<string, RouteHandler>) {
  const requests: RecordedRequest[] = []
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.pathname.replace(/^\/api\/v1/, '')
    const rawBody = init?.body
    const recorded: RecordedRequest = {
      method,
      path,
      url,
      headers: new Headers(init?.headers),
      body: typeof rawBody === 'string' ? (JSON.parse(rawBody) as unknown) : rawBody instanceof Blob ? rawBody : undefined,
    }
    requests.push(recorded)
    const route = `${method} ${path}`
    const handler = routes[route]
    if (!handler) {
      unhandledRequests.push(route)
      throw new Error(`Unhandled request in test: ${route}`)
    }
    return handler(recorded)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, requests }
}

/** A promise with external resolve, to hold a request "in flight". */
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export function makeMe(roles: Role[] = ['EMPLOYEE'], overrides: Partial<Me['user']> = {}): Me {
  return {
    user: {
      id: '7f0d1c0e-1111-4a5b-9c1d-000000000001',
      full_name: 'Lina Haddad',
      email: 'lina.haddad@example.com',
      phone: null,
      roles,
      department: { id: '7f0d1c0e-2222-4a5b-9c1d-000000000002', name: 'Finance', name_ar: null },
      must_change_password: false,
      preferred_language: null,
      ...overrides,
    },
    // English by default: the tests read the English UI (the setup pins it, F10-12).
    // Without a logo and a colour (Phase 12): the company's name is its wordmark, the default palette applies.
    company: {
      id: '7f0d1c0e-3333-4a5b-9c1d-000000000003',
      name: 'Acme Holdings',
      name_ar: null,
      slug: 'acme-holdings',
      timezone: 'Asia/Amman',
      default_language: 'en',
      brand: EMPTY_BRAND,
    },
  }
}

export const NOT_AUTHENTICATED = () => errorResponse(401, 'NOT_AUTHENTICATED', 'Please sign in.')

/**
 * The sign-in page of the test company (Phase 12): where a sign-out and an expired session lead on a
 * device that has signed in to it, in place of the neutral `/login`.
 */
export const COMPANY_SIGN_IN = '/c/acme-holdings'

/**
 * The public brand of a session's company (GET /public/companies/{slug}/brand): what its sign-in
 * page asks for once nobody is signed in. Spread it into the routes of a test that ends a session.
 */
export function publicBrandRoute(me: Me = makeMe()): Record<string, RouteHandler> {
  const { slug, name, name_ar, default_language, brand } = me.company
  return { [`GET /public/companies/${slug}/brand`]: () => jsonResponse({ slug, name, name_ar, default_language, brand }) }
}

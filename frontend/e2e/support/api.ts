import { request, type APIRequestContext, type APIResponse, type BrowserContext } from '@playwright/test'
import type {
  AuditLog,
  CheckInRequest,
  CheckOutRequest,
  InsideList,
  Me,
  Paginated,
  ScanResult,
  Visit,
  VisitCreate,
  VisitCreateResult,
  Visitor,
} from '../../src/types/api.ts'
import { platformStorageStatePath, storageStatePath, type AccountKey } from './accounts.ts'
import { BASE_URL } from './paths.ts'
import { sleep } from './processes.ts'

/*
 * The JSON API as a signed-in user, for setup steps and for checking what the UI stored. Requests go
 * through the Vite proxy like the browser's, carry the session cookie and, for unsafe methods, the
 * double-submit CSRF header (contract §7.2). No Origin header is sent, as for a same-origin fetch.
 */

const CSRF_COOKIES = ['__Host-vms_csrf', 'vms_csrf']
/** The platform owner's realm has a CSRF cookie of its own (Phase 11, B11-6), sent for /platform requests. */
const PLATFORM_CSRF_COOKIES = ['__Host-vms_platform_csrf', 'vms_platform_csrf']

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export class ApiStatusError extends Error {
  readonly status: number
  readonly body: string

  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} answered ${status}: ${body.slice(0, 500)}`)
    this.status = status
    this.body = body
  }
}

export interface ErrorEnvelope {
  error: { code: string; message: string; details: Record<string, unknown> }
  request_id: string
}

type CookieSource = () => Promise<{ name: string; value: string }[]>

export class Api {
  private readonly context: APIRequestContext
  /** Whether this helper created the request context (and so disposes of it). */
  private readonly owned: boolean
  private readonly cookies: CookieSource

  private constructor(context: APIRequestContext, owned: boolean, cookies: CookieSource) {
    this.context = context
    this.owned = owned
    this.cookies = cookies
  }

  /** A seeded account, signed in by the global setup. */
  static async as(account: AccountKey, baseURL: string = BASE_URL): Promise<Api> {
    const context = await request.newContext({ baseURL, storageState: storageStatePath(account) })
    return new Api(context, true, async () => (await context.storageState()).cookies)
  }

  /** The platform owner, signed in by the global setup (Phase 11). */
  static async platform(baseURL: string = BASE_URL): Promise<Api> {
    const context = await request.newContext({ baseURL, storageState: platformStorageStatePath() })
    return new Api(context, true, async () => (await context.storageState()).cookies)
  }

  /** The session of a browser context (shares its cookies), e.g. a user created during a test. */
  static of(browserContext: BrowserContext): Api {
    return new Api(browserContext.request, false, () => browserContext.cookies(BASE_URL))
  }

  /**
   * A company user created during a run (Phase 16: a company of its own for the area alerts), signed in with
   * `password` in a request context of its own.
   */
  static async signedIn(email: string, password: string, baseURL: string = BASE_URL): Promise<Api> {
    const context = await request.newContext({ baseURL })
    const api = new Api(context, true, async () => (await context.storageState()).cookies)
    await api.ok('POST', '/auth/login', { email, password })
    return api
  }

  /** No session at all. */
  static async anonymous(): Promise<Api> {
    const context = await request.newContext({ baseURL: BASE_URL })
    return new Api(context, true, async () => [])
  }

  async dispose(): Promise<void> {
    if (this.owned) await this.context.dispose()
  }

  /** Any request; the response is returned whatever its status. */
  async send(method: Method, path: string, body?: unknown): Promise<APIResponse> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (method !== 'GET') {
      const names = path === '/platform' || path.startsWith('/platform/') ? PLATFORM_CSRF_COOKIES : CSRF_COOKIES
      const csrf = (await this.cookies()).find((cookie) => names.includes(cookie.name))?.value
      if (csrf) headers['X-CSRF-Token'] = csrf
    }
    return this.context.fetch(`${BASE_URL}/api/v1${path}`, { method, headers, data: body, failOnStatusCode: false, timeout: 30_000 })
  }

  /**
   * A PNG as the raw body of a PUT (a company's brand file, Phase 12): what the identity page sends
   * after preparing a picture. The response is returned whatever its status.
   */
  async putPng(path: string, png: Buffer): Promise<APIResponse> {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'image/png' }
    const names = path === '/platform' || path.startsWith('/platform/') ? PLATFORM_CSRF_COOKIES : CSRF_COOKIES
    const csrf = (await this.cookies()).find((cookie) => names.includes(cookie.name))?.value
    if (csrf) headers['X-CSRF-Token'] = csrf
    return this.context.fetch(`${BASE_URL}/api/v1${path}`, { method: 'PUT', headers, data: png, failOnStatusCode: false, timeout: 30_000 })
  }

  /** A request that must succeed (2xx); its JSON body. */
  async ok<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const response = await this.send(method, path, body)
    if (!response.ok()) throw new ApiStatusError(method, path, response.status(), await response.text())
    return (response.status() === 204 ? undefined : await response.json()) as T
  }

  /** A request that must fail with `status`; its error envelope. */
  async fails(method: Method, path: string, status: number, body?: unknown): Promise<ErrorEnvelope> {
    const response = await this.send(method, path, body)
    const text = await response.text()
    if (response.status() !== status) throw new ApiStatusError(method, path, response.status(), `expected ${status}; ${text}`)
    return JSON.parse(text) as ErrorEnvelope
  }

  me(): Promise<Me> {
    return this.ok<Me>('GET', '/auth/me')
  }

  visit(id: string): Promise<Visit> {
    return this.ok<Visit>('GET', `/visits/${id}`)
  }

  visitor(id: string): Promise<Visitor> {
    return this.ok<Visitor>('GET', `/visitors/${id}`)
  }

  visitorVisits(id: string): Promise<Paginated<Visit>> {
    return this.ok<Paginated<Visit>>('GET', `/visitors/${id}/visits?page_size=100`)
  }

  /**
   * A visit hosted by the signed-in user unless `hostId` says otherwise. Without
   * `sendInvitation` no email is sent (the pass link is returned either way).
   */
  async createVisit(input: {
    visitor: VisitCreate['visitor'] | { id: string }
    start: Date
    end: Date
    purpose?: string
    hostId?: string
    departmentId?: string
    sendInvitation?: boolean
  }): Promise<VisitCreateResult> {
    const hostId = input.hostId ?? (await this.me()).user.id
    const visitor = input.visitor && 'id' in input.visitor ? { visitor_id: input.visitor.id } : { visitor: input.visitor }
    const body: VisitCreate = {
      ...visitor,
      host_id: hostId,
      ...(input.departmentId ? { department_id: input.departmentId } : {}),
      purpose: input.purpose ?? 'Project meeting',
      scheduled_start: input.start.toISOString(),
      scheduled_end: input.end.toISOString(),
      send_invitation: input.sendInvitation ?? false,
    }
    return this.ok<VisitCreateResult>('POST', '/visits', body)
  }

  scan(token: string): Promise<APIResponse> {
    return this.send('POST', '/reception/scan', { token })
  }

  async scanReady(token: string): Promise<ScanResult> {
    return this.ok<ScanResult>('POST', '/reception/scan', { token })
  }

  checkIn(visitId: string, body: CheckInRequest): Promise<Visit> {
    return this.ok<Visit>('POST', `/visits/${visitId}/check-in`, body)
  }

  checkOut(visitId: string, body: CheckOutRequest): Promise<Visit> {
    return this.ok<Visit>('POST', `/visits/${visitId}/check-out`, body)
  }

  inside(): Promise<InsideList> {
    return this.ok<InsideList>('GET', '/reception/inside')
  }

  async auditLogs(params: Record<string, string>): Promise<AuditLog[]> {
    const query = new URLSearchParams({ page_size: '100', ...params })
    return (await this.ok<Paginated<AuditLog>>('GET', `/audit-logs?${query}`)).items
  }

  /** Polls the visit until its latest invitation is no longer PENDING (delivery runs after the response). */
  async settledInvitation(visitId: string, timeoutMs = 20_000): Promise<Visit> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const visit = await this.visit(visitId)
      if (visit.invitation.status !== 'PENDING') return visit
      if (Date.now() > deadline) throw new Error(`The invitation of visit ${visitId} is still PENDING after ${timeoutMs} ms`)
      await sleep(250)
    }
  }
}

/** The token in a pass link: the URL fragment (contract §6). */
export function passToken(passUrl: string): string {
  return new URL(passUrl).hash.slice(1)
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred, errorResponse, jsonResponse, mockApi, noContent } from '../test/api'
import {
  ApiError,
  apiRequest,
  buildQueryString,
  getErrorReference,
  getFieldErrorCodes,
  getFieldErrors,
  NETWORK_ERROR_MESSAGE,
  readCsrfToken,
  subscribeToApiErrors,
  type ApiErrorListener,
} from './client'
import { listUsers } from './users'

function setCookieHeader(value: string) {
  return vi.spyOn(document, 'cookie', 'get').mockReturnValue(value)
}

function apiError(status: number, code: string, requestId: string | null = 'req-42'): ApiError {
  return new ApiError({ status, code, message: 'x', requestId })
}

describe('getErrorReference', () => {
  it('gives the request ID for server failures and non-API answers only', () => {
    expect(getErrorReference(apiError(500, 'INTERNAL_ERROR'))).toBe('req-42')
    expect(getErrorReference(apiError(503, 'SERVICE_BUSY'))).toBe('req-42')
    expect(getErrorReference(apiError(404, 'UNEXPECTED_RESPONSE'))).toBe('req-42')
    // A 4xx says what to change; a network error never reached the server.
    expect(getErrorReference(apiError(409, 'VISIT_NOT_EDITABLE'))).toBeNull()
    expect(getErrorReference(apiError(0, 'NETWORK_ERROR', null))).toBeNull()
    expect(getErrorReference(apiError(500, 'INTERNAL_ERROR', null))).toBeNull()
    expect(getErrorReference(new Error('boom'))).toBeNull()
  })
})

describe('readCsrfToken', () => {
  it('reads the secure __Host- cookie', () => {
    expect(readCsrfToken('theme=light; __Host-vms_csrf=secure-token')).toBe('secure-token')
  })

  it('reads the plain cookie used in local http development', () => {
    expect(readCsrfToken('vms_csrf=dev-token; other=1')).toBe('dev-token')
  })

  it('prefers the __Host- cookie when both exist', () => {
    expect(readCsrfToken('vms_csrf=dev-token; __Host-vms_csrf=secure-token')).toBe('secure-token')
  })

  it('decodes URL-encoded values and ignores look-alike names', () => {
    expect(readCsrfToken('xvms_csrf=nope; vms_csrf=a%2Bb%3D')).toBe('a+b=')
    expect(readCsrfToken('vms_csrf_other=nope')).toBeNull()
    expect(readCsrfToken('')).toBeNull()
  })
})

describe('buildQueryString', () => {
  it('serialises values, joins arrays with commas and skips empty values', () => {
    expect(
      buildQueryString({
        status: ['SCHEDULED', 'CHECKED_IN'],
        page: 2,
        needs_attention: true,
        q: '',
        host_id: undefined,
        visitor_id: null,
        empty: [],
      }),
    ).toBe('?status=SCHEDULED%2CCHECKED_IN&page=2&needs_attention=true')
    expect(buildQueryString({})).toBe('')
    expect(buildQueryString(undefined)).toBe('')
  })

  it('sends a multi-role user filter comma-separated (B1-20)', async () => {
    const { requests } = mockApi({ 'GET /users': () => jsonResponse({ items: [], page: 1, page_size: 25, total: 0 }) })

    await listUsers({ role: ['RECEPTIONIST', 'SYSTEM_ADMIN'], is_active: true })
    await listUsers({ role: ['MANAGEMENT'] })

    expect(requests.map((request) => request.url.search)).toEqual([
      '?role=RECEPTIONIST%2CSYSTEM_ADMIN&is_active=true',
      '?role=MANAGEMENT',
    ])
  })
})

describe('apiRequest', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('makes same-origin JSON requests under /api/v1', async () => {
    const { requests, fetchMock } = mockApi({ 'GET /visits': () => jsonResponse({ items: [], page: 1, page_size: 25, total: 0 }) })

    const result = await apiRequest('/visits', { query: { status: ['SCHEDULED'], page: 1 } })

    expect(result).toEqual({ items: [], page: 1, page_size: 25, total: 0 })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/visits?status=SCHEDULED&page=1',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }),
    )
    expect(requests[0]?.headers.get('Accept')).toBe('application/json')
  })

  it('never sends the CSRF header on safe methods', async () => {
    setCookieHeader('__Host-vms_csrf=secure-token')
    const { requests } = mockApi({ 'GET /auth/me': () => jsonResponse({}) })

    await apiRequest('/auth/me')

    expect(requests[0]?.headers.has('X-CSRF-Token')).toBe(false)
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('sends X-CSRF-Token from __Host-vms_csrf on %s', async (method) => {
    setCookieHeader('__Host-vms_csrf=secure-token')
    const { requests } = mockApi({ [`${method} /departments/1`]: () => jsonResponse({}) })

    await apiRequest('/departments/1', { method, body: { name: 'Finance' } })

    expect(requests[0]?.headers.get('X-CSRF-Token')).toBe('secure-token')
  })

  it('sends X-CSRF-Token from the plain vms_csrf cookie (COOKIE_SECURE=false)', async () => {
    document.cookie = 'vms_csrf=dev-token; path=/'
    const { requests } = mockApi({ 'POST /auth/logout': () => noContent() })

    await apiRequest('/auth/logout', { method: 'POST' })

    expect(requests[0]?.headers.get('X-CSRF-Token')).toBe('dev-token')
  })

  it('omits the CSRF header when no CSRF cookie exists (e.g. before login)', async () => {
    const { requests } = mockApi({ 'POST /auth/login': () => jsonResponse({}) })

    await apiRequest('/auth/login', { method: 'POST', body: { email: 'a@b.c', password: 'x' } })

    expect(requests[0]?.headers.has('X-CSRF-Token')).toBe(false)
  })

  it('serialises the body as JSON', async () => {
    const { requests } = mockApi({ 'POST /visitors': () => jsonResponse({ id: 'v1' }, 201) })

    await apiRequest('/visitors', { method: 'POST', body: { full_name: 'Élodie Martin' } })

    expect(requests[0]?.headers.get('Content-Type')).toBe('application/json')
    expect(requests[0]?.body).toEqual({ full_name: 'Élodie Martin' })
  })

  it('marks background refreshes with X-Background-Refresh: 1 only when asked', async () => {
    const { requests } = mockApi({ 'GET /reception/today': () => jsonResponse({}) })

    await apiRequest('/reception/today', { backgroundRefresh: true })
    await apiRequest('/reception/today')

    expect(requests[0]?.headers.get('X-Background-Refresh')).toBe('1')
    expect(requests[1]?.headers.has('X-Background-Refresh')).toBe(false)
  })

  it('resolves undefined for 204 No Content', async () => {
    mockApi({ 'POST /auth/logout': () => noContent() })
    await expect(apiRequest('/auth/logout', { method: 'POST' })).resolves.toBeUndefined()
  })

  it('parses the error envelope into an ApiError', async () => {
    mockApi({
      'POST /reception/scan': () =>
        errorResponse(410, 'PASS_EXPIRED', 'This visitor pass has expired.', { check_in_options: ['OVERRIDE'] }),
    })

    const error = await apiRequest('/reception/scan', { method: 'POST', body: { token: 'x' } }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 410,
      code: 'PASS_EXPIRED',
      message: 'This visitor pass has expired.',
      details: { check_in_options: ['OVERRIDE'] },
      requestId: 'req-test-1',
    })
  })

  it('exposes 422 field errors', async () => {
    mockApi({
      'POST /users': () =>
        errorResponse(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', {
          fields: { email: 'Enter a valid email.', roles: 42 },
        }),
    })

    const error = await apiRequest('/users', { method: 'POST', body: {} }).catch((e: unknown) => e)

    expect(getFieldErrors(error)).toEqual({ email: 'Enter a valid email.' })
    expect(getFieldErrors(new Error('x'))).toEqual({})
  })

  it('exposes the codes of 422 field errors, leaving out malformed entries and parameters', async () => {
    mockApi({
      'POST /users': () =>
        errorResponse(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', {
          fields: { email: 'Email address is too long.', roles: 'Choose one of: x.', phone: 'x', full_name: 'y', department_id: 'z' },
          field_codes: {
            email: { code: 'too_long', params: { max: 320 } },
            roles: { code: 'invalid_choice', params: { choices: ['ADMIN', 'EMPLOYEE'], stray: { nested: true } } },
            phone: { code: 42, params: {} },
            full_name: 'required',
            department_id: { code: 'not_found' },
          },
        }),
    })

    const error = await apiRequest('/users', { method: 'POST', body: {} }).catch((e: unknown) => e)

    expect(getFieldErrorCodes(error)).toEqual({
      email: { code: 'too_long', params: { max: 320 } },
      roles: { code: 'invalid_choice', params: { choices: ['ADMIN', 'EMPLOYEE'] } },
      department_id: { code: 'not_found', params: {} },
    })
    expect(getFieldErrorCodes(new ApiError({ status: 422, code: 'VALIDATION_ERROR', message: 'x', details: { fields: {} } }))).toEqual({})
    expect(getFieldErrorCodes(new ApiError({ status: 409, code: 'CONFLICT', message: 'x', details: { field_codes: { a: { code: 'required', params: {} } } } }))).toEqual({})
    expect(getFieldErrorCodes(new Error('x'))).toEqual({})
  })

  it('maps responses without an envelope (proxy/gateway errors) to a friendly error', async () => {
    mockApi({
      'GET /health': () =>
        new Response('<html>Bad gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html', 'X-Request-ID': 'gw-1' } }),
    })

    const error = await apiRequest('/health').catch((e: unknown) => e)

    expect(error).toMatchObject({
      status: 502,
      code: 'UNEXPECTED_RESPONSE',
      message: 'The service is temporarily unavailable. Please try again shortly.',
      requestId: 'gw-1',
    })
  })

  it('rejects a 2xx response that is not JSON (misrouted /api request)', async () => {
    mockApi({ 'GET /auth/me': () => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }) })
    await expect(apiRequest('/auth/me')).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' })
  })

  it('turns network failures into a friendly NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')))

    const error = await apiRequest('/auth/me').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 0, code: 'NETWORK_ERROR', message: NETWORK_ERROR_MESSAGE, isNetworkError: true })
  })

  it('lets aborts propagate unchanged', async () => {
    const controller = new AbortController()
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => {
        controller.abort()
        return Promise.reject(abortError)
      }),
    )

    await expect(apiRequest('/visits', { signal: controller.signal })).rejects.toBe(abortError)
  })

  it('notifies error listeners until they unsubscribe', async () => {
    const listener = vi.fn<ApiErrorListener>()
    const unsubscribe = subscribeToApiErrors(listener)
    mockApi({ 'GET /visits': () => errorResponse(401, 'NOT_AUTHENTICATED', 'Please sign in.') })

    await apiRequest('/visits').catch(() => undefined)
    unsubscribe()
    await apiRequest('/visits').catch(() => undefined)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 401, code: 'NOT_AUTHENTICATED' }), {
      method: 'GET',
      path: '/visits',
    })
  })

  it('does not notify listeners about network errors', async () => {
    const listener = vi.fn<ApiErrorListener>()
    const unsubscribe = subscribeToApiErrors(listener)
    const pending = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => pending.promise))

    const request = apiRequest('/visits').catch(() => undefined)
    pending.reject(new TypeError('offline'))
    await request
    unsubscribe()

    expect(listener).not.toHaveBeenCalled()
  })
})

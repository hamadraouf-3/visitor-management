import { errorMessage, fallbackErrorMessage } from '../i18n/errorMessages'
import type { ApiErrorCode, ApiErrorEnvelope, FieldErrorCodeEntry, ValidationErrorDetails } from '../types/api'

/** All API calls are same-origin (Vite proxy in dev, nginx in production): no CORS. */
export const API_BASE_PATH = '/api/v1'

/** The secure (`__Host-`) name is used when COOKIE_SECURE=true; the plain one in local http dev (§7.2). */
export const CSRF_COOKIE_NAMES = ['__Host-vms_csrf', 'vms_csrf'] as const
/**
 * The platform owner's CSRF cookie (Phase 11, B11-6): its own realm. Every unsafe request under
 * `/api/v1/platform` is checked against the platform session's token, never the company's, and a
 * browser may hold both sessions at once.
 */
export const PLATFORM_CSRF_COOKIE_NAMES = ['__Host-vms_platform_csrf', 'vms_platform_csrf'] as const
export const CSRF_HEADER = 'X-CSRF-Token'
export const BACKGROUND_REFRESH_HEADER = 'X-Background-Refresh'

/*
 * The English messages of failures that never produced an API error envelope. They are the
 * `ApiError.message` (logs, tests); the UI shows `getErrorMessage`, which translates by code.
 */
export const NETWORK_ERROR_MESSAGE =
  'We could not reach the server. Check your connection and try again.'
const FALLBACK_ERROR_MESSAGE = 'Something went wrong. Please try again.'
const UNAVAILABLE_ERROR_MESSAGE = 'The service is temporarily unavailable. Please try again shortly.'

/** Client-side codes for failures that never produced an API error envelope. */
export type ClientErrorCode = 'NETWORK_ERROR' | 'UNEXPECTED_RESPONSE'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode | ClientErrorCode | (string & {})
  readonly details: Record<string, unknown>
  readonly requestId: string | null
  /** Seconds to wait before trying again, from a 429's or 503's `Retry-After` header; null when the server did not say. */
  readonly retryAfter: number | null

  constructor(init: {
    status: number
    code: ApiError['code']
    message: string
    details?: Record<string, unknown>
    requestId?: string | null
    retryAfter?: number | null
    cause?: unknown
  }) {
    super(init.message, { cause: init.cause })
    this.name = 'ApiError'
    this.status = init.status
    this.code = init.code
    this.details = init.details ?? {}
    this.requestId = init.requestId ?? null
    this.retryAfter = init.retryAfter ?? null
  }

  get isNetworkError(): boolean {
    return this.code === 'NETWORK_ERROR'
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

/** True when `error` is an ApiError with one of the given codes. */
export function hasErrorCode(error: unknown, ...codes: ApiError['code'][]): error is ApiError {
  return isApiError(error) && codes.includes(error.code)
}

/**
 * The seconds a rate-limited request (429 RATE_LIMITED) says to wait, from its `Retry-After`; null
 * for any other error, and when the server did not say. A screen that knows the wait says it in
 * words (`formatWaitDuration`) instead of the code's general message.
 */
export function rateLimitWaitSeconds(error: unknown): number | null {
  return hasErrorCode(error, 'RATE_LIMITED') ? error.retryAfter : null
}

/** Field messages of a 422 VALIDATION_ERROR (`details.fields`), keyed by field path. */
export function getFieldErrors(error: unknown): NonNullable<ValidationErrorDetails['fields']> {
  if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') return {}
  const fields = error.details.fields
  if (!fields || typeof fields !== 'object') return {}
  return Object.fromEntries(
    Object.entries(fields as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

/** One entry of a 422's `details.field_codes`; `code` may be one a newer server added. */
export interface FieldCodeEntry {
  code: FieldErrorCodeEntry['code'] | (string & {})
  params: FieldErrorCodeEntry['params']
}

function isParamValue(value: unknown): value is FieldErrorCodeEntry['params'][string] {
  return (
    typeof value === 'number' ||
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  )
}

/**
 * The machine codes of a 422 VALIDATION_ERROR's field errors (`details.field_codes`, backend
 * B10-18), keyed by the same paths as `getFieldErrors`. An entry that is not `{code, params}`
 * is left out (its field keeps the server's message); an older server sends none.
 */
export function getFieldErrorCodes(error: unknown): Record<string, FieldCodeEntry> {
  if (!isApiError(error) || error.code !== 'VALIDATION_ERROR') return {}
  const codes = error.details.field_codes
  if (!codes || typeof codes !== 'object') return {}
  const entries: [string, FieldCodeEntry][] = []
  for (const [path, entry] of Object.entries(codes as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue
    const { code, params } = entry as { code?: unknown; params?: unknown }
    if (typeof code !== 'string' || code === '') continue
    const parameters = params && typeof params === 'object' && !Array.isArray(params) ? (params as Record<string, unknown>) : {}
    entries.push([path, { code, params: Object.fromEntries(Object.entries(parameters).filter((param) => isParamValue(param[1]))) as FieldCodeEntry['params'] }])
  }
  return Object.fromEntries(entries)
}

/**
 * A user-facing message for any thrown value, in the UI language: the server's own (English)
 * message in English, the `errors` catalog's text for the error code in Arabic (F10-6).
 */
export function getErrorMessage(error: unknown): string {
  if (isApiError(error)) return errorMessage(error)
  return fallbackErrorMessage()
}

/**
 * The request ID to quote to the service desk, for failures the user cannot fix themselves:
 * server errors (5xx) and responses that never were an API answer (a gateway page). The ID is
 * what the backend logs carry (§8 envelope `request_id`, or the `X-Request-ID` header). A 4xx
 * already says what to change, and a network error never reached the server, so neither has one.
 */
export function getErrorReference(error: unknown): string | null {
  if (!isApiError(error) || !error.requestId) return null
  return error.status >= 500 || error.code === 'UNEXPECTED_RESPONSE' ? error.requestId : null
}

/* ------------------------------------------------------------------------------------------ */
/* Error listeners: the auth layer reacts to 401 / PASSWORD_CHANGE_REQUIRED globally.          */
/* ------------------------------------------------------------------------------------------ */

export type ApiErrorListener = (error: ApiError, request: { method: string; path: string }) => void

const errorListeners = new Set<ApiErrorListener>()

export function subscribeToApiErrors(listener: ApiErrorListener): () => void {
  errorListeners.add(listener)
  return () => {
    errorListeners.delete(listener)
  }
}

function notifyErrorListeners(error: ApiError, method: string, path: string): void {
  for (const listener of errorListeners) {
    try {
      listener(error, { method, path })
    } catch (listenerError) {
      console.error('API error listener failed', listenerError)
    }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Request                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[]
export type QueryParams = object

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: QueryParams
  body?: unknown
  /**
   * A body that is not JSON, sent as it is with its own content type: the PNG of a company's logo
   * (Phase 12). `body` is then not used.
   */
  binary?: { body: Blob; contentType: string }
  signal?: AbortSignal
  /**
   * Marks automatic polling (e.g. reception lists). The server then does not extend the
   * session idle timeout, so shared tablets still sign out when unattended (§7.2).
   */
  backgroundRefresh?: boolean
}

/** Per-call options accepted by every resource function. */
export type CallOptions = Pick<RequestOptions, 'signal' | 'backgroundRefresh'>

/** Encodes one path segment (IDs are UUIDs, but never trust interpolated values). */
export function segment(value: string): string {
  return encodeURIComponent(value)
}

/** Whether `path` (below `/api/v1`) belongs to the platform owner's realm (`/platform`, `/platform/…`). */
export function isPlatformPath(path: string): boolean {
  return path === '/platform' || path.startsWith('/platform/') || path.startsWith('/platform?')
}

/** The CSRF cookie that vouches for a request to `path`: the platform's under `/platform`, the company's elsewhere. */
export function csrfCookieNamesFor(path: string): readonly string[] {
  return isPlatformPath(path) ? PLATFORM_CSRF_COOKIE_NAMES : CSRF_COOKIE_NAMES
}

/** Reads a CSRF cookie set by the server at sign-in; whichever variant of `names` exists (§7.2). */
export function readCsrfToken(cookieString: string = document.cookie, names: readonly string[] = CSRF_COOKIE_NAMES): string | null {
  const cookies = new Map<string, string>()
  for (const part of cookieString.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    const name = part.slice(0, separator).trim()
    if (!cookies.has(name)) cookies.set(name, part.slice(separator + 1).trim())
  }
  for (const name of names) {
    const value = cookies.get(name)
    if (value) {
      try {
        return decodeURIComponent(value)
      } catch {
        return value
      }
    }
  }
  return null
}

/** Serialises query params: skips empty values; arrays are comma-separated (§8). */
export function buildQueryString(query: QueryParams | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, raw] of Object.entries(query) as [string, QueryValue][]) {
    if (raw === undefined || raw === null || raw === '') continue
    if (Array.isArray(raw)) {
      if (raw.length > 0) params.set(key, raw.join(','))
      continue
    }
    params.set(key, String(raw))
  }
  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

function isErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (!value || typeof value !== 'object') return false
  const error = (value as { error?: unknown }).error
  return (
    !!error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  )
}

type JsonBody = { kind: 'empty' } | { kind: 'json'; value: unknown } | { kind: 'invalid' }

async function readJson(response: Response): Promise<JsonBody> {
  const text = await response.text()
  if (!text) return { kind: 'empty' }
  try {
    return { kind: 'json', value: JSON.parse(text) as unknown }
  } catch {
    return { kind: 'invalid' }
  }
}

/** `Retry-After` in seconds (the API sends a number of seconds, never a date); null when absent or unreadable. */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\s*\d+\s*$/.test(value)) return null
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null
}

async function toApiError(response: Response): Promise<ApiError> {
  const parsed = await readJson(response)
  const body = parsed.kind === 'json' ? parsed.value : undefined
  const headerRequestId = response.headers.get('X-Request-ID')
  const retryAfter = parseRetryAfter(response.headers.get('Retry-After'))
  if (isErrorEnvelope(body)) {
    return new ApiError({
      status: response.status,
      code: body.error.code,
      message: body.error.message,
      details: body.error.details && typeof body.error.details === 'object' ? body.error.details : {},
      requestId: body.request_id ?? headerRequestId,
      retryAfter,
    })
  }
  // No envelope: the request never reached the API (proxy/gateway error, HTML error page).
  const unavailable = response.status === 502 || response.status === 503 || response.status === 504
  return new ApiError({
    status: response.status,
    code: 'UNEXPECTED_RESPONSE',
    message: unavailable ? UNAVAILABLE_ERROR_MESSAGE : FALLBACK_ERROR_MESSAGE,
    requestId: headerRequestId,
    retryAfter,
  })
}

/**
 * The same-origin address of an API document (`/api/v1` + path + query), for a frame or a link that
 * the browser loads itself, such as the saved e-mail preview (GET /email-templates/{kind}/preview).
 */
export function apiUrl(path: string, query?: QueryParams): string {
  return `${API_BASE_PATH}${path}${buildQueryString(query)}`
}

/**
 * Performs a same-origin JSON request against `/api/v1`. Resolves with the parsed body
 * (`undefined` for 204) or rejects with an {@link ApiError}. Aborts propagate unchanged.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const headers = new Headers({ Accept: 'application/json' })

  let body: string | Blob | undefined
  if (options.binary) {
    headers.set('Content-Type', options.binary.contentType)
    body = options.binary.body
  } else if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(options.body)
  }
  if (!SAFE_METHODS.has(method)) {
    // Each realm's own token: the platform's for /platform requests, the company's elsewhere (B11-6).
    const csrfToken = readCsrfToken(document.cookie, csrfCookieNamesFor(path))
    if (csrfToken) headers.set(CSRF_HEADER, csrfToken)
  }
  if (options.backgroundRefresh) headers.set(BACKGROUND_REFRESH_HEADER, '1')

  let response: Response
  try {
    response = await fetch(`${API_BASE_PATH}${path}${buildQueryString(options.query)}`, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
    })
  } catch (cause) {
    if (options.signal?.aborted) throw cause
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: NETWORK_ERROR_MESSAGE, cause })
  }

  if (!response.ok) {
    const error = await toApiError(response)
    notifyErrorListeners(error, method, path)
    throw error
  }

  if (response.status === 204) return undefined as T
  const parsed = await readJson(response)
  if (parsed.kind === 'invalid') {
    // e.g. an HTML page served for an /api path by a misconfigured proxy.
    throw new ApiError({
      status: response.status,
      code: 'UNEXPECTED_RESPONSE',
      message: FALLBACK_ERROR_MESSAGE,
      requestId: response.headers.get('X-Request-ID'),
    })
  }
  return (parsed.kind === 'json' ? parsed.value : undefined) as T
}

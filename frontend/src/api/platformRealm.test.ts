import { describe, expect, it, vi } from 'vitest'
import { errorResponse, jsonResponse, mockApi, noContent } from '../test/api'
import { apiRequest, apiUrl, csrfCookieNamesFor, isApiError, isPlatformPath, parseRetryAfter, readCsrfToken } from './client'
import { createPlatformCompany, platformLogout } from './platform'
import { emailTemplatePreviewUrl, updateEmailTemplate } from './emailTemplates'

/*
 * Phase 11 (B11-6): the platform owner is another principal with its own CSRF cookie. Every unsafe
 * request under /api/v1/platform sends the platform token, every other the company's; a browser may
 * hold both cookies at once.
 */

const BOTH = '__Host-vms_csrf=company-token; __Host-vms_platform_csrf=platform-token'

function cookies(value: string) {
  return vi.spyOn(document, 'cookie', 'get').mockReturnValue(value)
}

describe('the CSRF cookie of each realm', () => {
  it('knows the platform paths', () => {
    expect(isPlatformPath('/platform/companies')).toBe(true)
    expect(isPlatformPath('/platform/auth/logout')).toBe(true)
    expect(isPlatformPath('/platform')).toBe(true)
    expect(isPlatformPath('/platforms')).toBe(false)
    expect(isPlatformPath('/email-templates/VISITOR_INVITATION')).toBe(false)
    expect(isPlatformPath('/auth/logout')).toBe(false)
  })

  it('reads the platform cookie for /platform and the company cookie elsewhere, in both cookie variants', () => {
    expect(readCsrfToken(BOTH, csrfCookieNamesFor('/platform/companies'))).toBe('platform-token')
    expect(readCsrfToken(BOTH, csrfCookieNamesFor('/users'))).toBe('company-token')
    expect(readCsrfToken('vms_platform_csrf=dev-platform; vms_csrf=dev-company', csrfCookieNamesFor('/platform/auth/logout'))).toBe('dev-platform')
    // The company's token never vouches for a platform request, nor the reverse.
    expect(readCsrfToken('__Host-vms_csrf=company-token', csrfCookieNamesFor('/platform/companies'))).toBeNull()
    expect(readCsrfToken('__Host-vms_platform_csrf=platform-token', csrfCookieNamesFor('/users'))).toBeNull()
  })

  it('sends the platform token on unsafe platform requests and the company token on company requests', async () => {
    cookies(BOTH)
    const { requests } = mockApi({
      'POST /platform/companies': () => jsonResponse({}, 201),
      'POST /platform/auth/logout': () => noContent(),
      'PATCH /email-templates/VISITOR_INVITATION': () => jsonResponse({}),
    })
    await createPlatformCompany({
      name: 'Nova',
      slug: 'nova',
      timezone: 'Asia/Amman',
      default_language: 'en',
      admin: { full_name: 'Nadia', email: 'n@nova.example', temporary_password: 'x' },
    })
    await platformLogout()
    await updateEmailTemplate('VISITOR_INVITATION', { en: { subject: 'Hi {company}' } })
    expect(requests.map((request) => request.headers.get('X-CSRF-Token'))).toEqual(['platform-token', 'platform-token', 'company-token'])
  })

  it('sends no token for a platform request without a platform cookie (signed in to the company only)', async () => {
    cookies('__Host-vms_csrf=company-token')
    const { requests } = mockApi({ 'POST /platform/auth/logout': () => noContent() })
    await platformLogout()
    expect(requests[0]?.headers.has('X-CSRF-Token')).toBe(false)
  })
})

describe('Retry-After', () => {
  it('reads whole seconds and nothing else', () => {
    expect(parseRetryAfter('42')).toBe(42)
    expect(parseRetryAfter(' 7 ')).toBe(7)
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('0')).toBeNull()
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull()
  })

  it('puts the seconds on the ApiError of a 429', async () => {
    mockApi({
      'POST /email-templates/VISITOR_INVITATION/test': () =>
        new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests.', details: {} }, request_id: 'r' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '1800' },
        }),
    })
    const error = await apiRequest('/email-templates/VISITOR_INVITATION/test', { method: 'POST', body: { language: 'en' } }).catch((caught: unknown) => caught)
    expect(isApiError(error) && error.retryAfter).toBe(1800)
  })

  it('is null when the server did not say', async () => {
    mockApi({ 'GET /users': () => errorResponse(404, 'NOT_FOUND', 'x') })
    const error = await apiRequest('/users').catch((caught: unknown) => caught)
    expect(isApiError(error) && error.retryAfter).toBeNull()
  })
})

describe('API document addresses', () => {
  it('builds the saved e-mail preview address for a sandboxed frame', () => {
    expect(emailTemplatePreviewUrl('HOST_ARRIVAL', { language: 'ar' })).toBe('/api/v1/email-templates/HOST_ARRIVAL/preview?language=ar')
    expect(apiUrl('/health')).toBe('/api/v1/health')
  })
})

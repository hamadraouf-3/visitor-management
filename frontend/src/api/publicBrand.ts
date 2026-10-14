import { parsePublicBrand } from '../identity/brand'
import type { PublicCompanyBrand } from '../types/api'
import { API_BASE_PATH, ApiError, NETWORK_ERROR_MESSAGE, segment } from './client'

/**
 * A company's public identity (Phase 12, GET /public/companies/{slug}/brand): what its sign-in page
 * and its visitors' passes show. Null when no active company has that slug (the server answers an
 * unknown and a deactivated company alike), and when the answer is not a brand: the page is then
 * the neutral one.
 *
 * The request is anonymous on purpose: no cookie, no CSRF token, no referrer. The visitor's pass
 * makes this request and no other, and the pass token, which lives in the address's fragment, is
 * no part of it.
 */
export async function getPublicBrand(slug: string, { signal }: { signal?: AbortSignal } = {}): Promise<PublicCompanyBrand | null> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_PATH}/public/companies/${segment(slug)}/brand`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal,
    })
  } catch (cause) {
    if (signal?.aborted) throw cause
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: NETWORK_ERROR_MESSAGE, cause })
  }
  if (response.status === 404) return null
  if (!response.ok) throw new ApiError({ status: response.status, code: 'UNEXPECTED_RESPONSE', message: `Brand request failed (${response.status})` })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return null
  }
  const brand = parsePublicBrand(body)
  // A brand of another company than the one asked for is not this page's.
  return brand && brand.slug === slug ? brand : null
}

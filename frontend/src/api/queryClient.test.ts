import { describe, expect, it } from 'vitest'
import { ApiError } from './client'
import { shouldRetryQuery } from './queryClient'

const error = (status: number, code: string) => new ApiError({ status, code, message: 'x' })

describe('shouldRetryQuery', () => {
  it('retries transient failures at most twice', () => {
    expect(shouldRetryQuery(0, error(0, 'NETWORK_ERROR'))).toBe(true)
    expect(shouldRetryQuery(1, error(503, 'SERVICE_BUSY'))).toBe(true)
    expect(shouldRetryQuery(0, error(502, 'UNEXPECTED_RESPONSE'))).toBe(true)
    expect(shouldRetryQuery(2, error(0, 'NETWORK_ERROR'))).toBe(false)
  })

  it('never retries definitive answers', () => {
    for (const [status, code] of [
      [401, 'NOT_AUTHENTICATED'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [409, 'CONFLICT'],
      [422, 'VALIDATION_ERROR'],
      [429, 'RATE_LIMITED'],
      [500, 'INTERNAL_ERROR'],
    ] as const) {
      expect(shouldRetryQuery(0, error(status, code))).toBe(false)
    }
    expect(shouldRetryQuery(0, new Error('bug'))).toBe(false)
  })
})

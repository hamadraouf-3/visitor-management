import { describe, expect, it } from 'vitest'
import { apiRequest } from '../api/client'
import { assertNoUnhandledRequests, jsonResponse, mockApi } from './api'

describe('mockApi', () => {
  it('serves matching routes and records every request', async () => {
    const { requests } = mockApi({ 'GET /health': () => jsonResponse({ status: 'ok', database: 'ok' }) })

    await expect(apiRequest('/health')).resolves.toEqual({ status: 'ok', database: 'ok' })
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual(['GET /health'])
    expect(() => assertNoUnhandledRequests()).not.toThrow()
  })

  it('remembers unhandled requests even when the caller swallows the failure', async () => {
    mockApi({})

    // The client turns the rejected fetch into a NETWORK_ERROR the UI would only show as a message.
    await expect(apiRequest('/visits?status=SCHEDULED')).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    await fetch('/node_modules/zxing-wasm/dist/reader/zxing_reader.wasm').catch(() => undefined)

    // The test setup runs this after every test; called here to observe it (it also resets).
    expect(() => assertNoUnhandledRequests()).toThrow(
      /GET \/visits\n {2}GET \/node_modules\/zxing-wasm\/dist\/reader\/zxing_reader\.wasm$/,
    )
    expect(() => assertNoUnhandledRequests()).not.toThrow()
  })
})

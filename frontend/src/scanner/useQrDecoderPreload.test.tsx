import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useQrDecoderPreload } from './useQrDecoderPreload'
import { preloadQrDecoder } from './zxing'

// './zxing' is the inert decoder from the test setup, so no wasm is fetched here.
describe('useQrDecoderPreload', () => {
  it('starts loading the decoder on mount and reports the engine', async () => {
    const { result } = renderHook(() => useQrDecoderPreload())

    expect(result.current).toEqual({ status: 'loading' })
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', engine: 'zxing' }))
    expect(preloadQrDecoder).toHaveBeenCalledOnce()
  })

  it('reports a failed preload in its state', async () => {
    const failure = new Error('both async and sync fetching of the wasm failed')
    vi.mocked(preloadQrDecoder).mockRejectedValueOnce(failure)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { result } = renderHook(() => useQrDecoderPreload())

    await waitFor(() => expect(result.current).toEqual({ status: 'error', error: failure }))
    expect(warn).toHaveBeenCalledWith('QR decoder preload failed', failure)
  })
})

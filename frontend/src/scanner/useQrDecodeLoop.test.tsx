import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeCamera, type FakeCamera } from './testing/fakeCamera'
import { DECODE_INTERVAL_MS, useQrDecodeLoop } from './useQrDecodeLoop'
import { createQrDetector, type QrDetector } from './zxing'

// './zxing' is the inert decoder of the test setup; each test hands it a detector to drive.
let camera: FakeCamera
let detect: ReturnType<typeof vi.fn<QrDetector['detect']>>

function useDetections(values: (string | null)[]) {
  let index = 0
  detect.mockImplementation(() => {
    const value = values[Math.min(index, values.length - 1)] ?? null
    index += 1
    return Promise.resolve(value ? [{ rawValue: value }] : [])
  })
}

/** Advances fake time in small steps, each in its own act(), so React renders between timers as in a browser. */
async function advance(ms: number, step = 40) {
  let left = ms
  do {
    const next = Math.min(step, left)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(next)
    })
    left -= next
  } while (left > 0)
}

describe('useQrDecodeLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    camera = installFakeCamera()
    detect = vi.fn<QrDetector['detect']>(() => Promise.resolve([]))
    vi.mocked(createQrDetector).mockResolvedValue({ engine: 'zxing', detector: { detect } })
  })
  afterEach(() => {
    vi.useRealTimers()
    camera.restore()
  })

  it('decodes frames while active and reports every decoded value', async () => {
    useDetections([null, 'first', null, 'second'])
    const onDecode = vi.fn<(rawValue: string) => void>()
    const video = document.createElement('video')
    renderHook(() => useQrDecodeLoop({ video, active: true, onDecode }))

    await advance(DECODE_INTERVAL_MS * 4)
    expect(onDecode.mock.calls.map(([value]) => value)).toEqual(['first', 'second'])
    expect(detect).toHaveBeenCalledWith(video)
  })

  it('stops decoding as soon as it is inactive (a result is shown) and resumes after', async () => {
    useDetections(['code'])
    const onDecode = vi.fn<(rawValue: string) => void>()
    const video = document.createElement('video')
    const { rerender } = renderHook(({ active }) => useQrDecodeLoop({ video, active, onDecode }), { initialProps: { active: true } })
    await advance(0)
    expect(onDecode).toHaveBeenCalledTimes(1)

    rerender({ active: false })
    const calls = detect.mock.calls.length
    await advance(DECODE_INTERVAL_MS * 10)
    expect(detect.mock.calls.length).toBe(calls)
    expect(onDecode).toHaveBeenCalledTimes(1)

    rerender({ active: true })
    await advance(0)
    expect(onDecode).toHaveBeenCalledTimes(2)
  })

  it('does not decode without a video element, or before the first frame', async () => {
    const onDecode = vi.fn<(rawValue: string) => void>()
    const { rerender } = renderHook(({ video }) => useQrDecodeLoop({ video, active: true, onDecode }), {
      initialProps: { video: null as HTMLVideoElement | null },
    })
    await advance(DECODE_INTERVAL_MS * 3)
    expect(detect).not.toHaveBeenCalled()

    vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(1)
    rerender({ video: document.createElement('video') })
    await advance(DECODE_INTERVAL_MS * 3)
    expect(detect).not.toHaveBeenCalled()
  })

  it('skips a frame the decoder cannot read and keeps scanning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    detect.mockRejectedValueOnce(new Error('frame not ready')).mockResolvedValue([{ rawValue: 'code' }])
    const onDecode = vi.fn<(rawValue: string) => void>()
    renderHook(() => useQrDecodeLoop({ video: document.createElement('video'), active: true, onDecode }))

    await advance(DECODE_INTERVAL_MS * 2)
    expect(onDecode).toHaveBeenCalledWith('code')
    expect(warn).toHaveBeenCalledOnce()
  })

  it('reports a decoder that cannot be created', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(createQrDetector).mockRejectedValue(new Error('wasm blocked'))
    const { result } = renderHook(() => useQrDecodeLoop({ video: document.createElement('video'), active: true, onDecode: () => {} }))

    await advance(0)
    expect(result.current.failed).toBe(true)
    expect(warn).toHaveBeenCalled()
  })
})

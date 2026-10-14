import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deferred } from '../test/api'
import { CAMERA_ERRORS } from './cameraErrors'
import { markCameraUsed, readCameraDeviceId, storeCameraDeviceId } from './preferences'
import { fakeStream, fakeTrack, installFakeCamera, mediaError, type FakeCamera } from './testing/fakeCamera'
import { useCameraStream, videoConstraints } from './useCameraStream'

let camera: FakeCamera | undefined

function install(options: Parameters<typeof installFakeCamera>[0] = {}): FakeCamera {
  camera = installFakeCamera(options)
  return camera
}

function setVisibility(state: DocumentVisibilityState) {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state)
  document.dispatchEvent(new Event('visibilitychange'))
}

afterEach(() => {
  camera?.restore()
  camera = undefined
  window.localStorage.clear()
})

describe('videoConstraints', () => {
  it('asks for the rear camera only as a preference, never exactly (§10)', () => {
    expect(videoConstraints(null)).toEqual({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    })
  })

  it('asks for a camera the user picked exactly', () => {
    expect(videoConstraints('camera-front').video).toMatchObject({ deviceId: { exact: 'camera-front' } })
  })
})

describe('useCameraStream: auto-start', () => {
  it('starts on its own when camera access was granted before (Permissions API)', async () => {
    const { getUserMedia } = install({ permission: 'granted' })
    const { result } = renderHook(() => useCameraStream({ autoStart: true }))

    await waitFor(() => expect(result.current.status).toBe('live'))
    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(getUserMedia).toHaveBeenCalledWith(videoConstraints(null))
    expect(result.current.deviceId).toBe('camera-rear')
    await waitFor(() => expect(result.current.devices).toEqual([{ deviceId: 'camera-rear', label: 'Back camera' }]))
  })

  it('waits for a click while the browser would still ask for permission', async () => {
    const { getUserMedia } = install({ permission: 'prompt' })
    const { result } = renderHook(() => useCameraStream({ autoStart: true }))

    await act(async () => {})
    expect(result.current.status).toBe('idle')
    expect(getUserMedia).not.toHaveBeenCalled()

    act(() => result.current.start())
    await waitFor(() => expect(result.current.status).toBe('live'))
  })

  it('shows a denied permission at once, without asking the browser', async () => {
    const { getUserMedia } = install({ permission: 'denied' })
    const { result } = renderHook(() => useCameraStream({ autoStart: true }))

    await waitFor(() => expect(result.current.error?.kind).toBe('permission-denied'))
    expect(result.current.status).toBe('error')
    expect(getUserMedia).not.toHaveBeenCalled()
  })

  it('without the Permissions API, starts on its own only if the camera started on this device before', async () => {
    const first = install({ permission: null })
    const { result, unmount } = renderHook(() => useCameraStream({ autoStart: true }))
    await act(async () => {})
    expect(result.current.status).toBe('idle')
    expect(first.getUserMedia).not.toHaveBeenCalled()
    unmount()

    markCameraUsed()
    const again = renderHook(() => useCameraStream({ autoStart: true }))
    await waitFor(() => expect(again.result.current.status).toBe('live'))
  })

  it('does not start while auto-start is off (another tab is shown)', async () => {
    const { getUserMedia } = install({ permission: 'granted' })
    const { result, rerender } = renderHook(({ autoStart }) => useCameraStream({ autoStart }), { initialProps: { autoStart: false } })
    await act(async () => {})
    expect(getUserMedia).not.toHaveBeenCalled()

    rerender({ autoStart: true })
    await waitFor(() => expect(result.current.status).toBe('live'))
  })

  it('starts once access is granted in the browser’s own settings', async () => {
    const fake = install({ permission: 'denied' })
    const { result } = renderHook(() => useCameraStream({ autoStart: true }))
    await waitFor(() => expect(result.current.error?.kind).toBe('permission-denied'))

    act(() => fake.setPermission('granted'))
    await waitFor(() => expect(result.current.status).toBe('live'))
  })
})

describe('useCameraStream: errors', () => {
  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['NotFoundError', 'no-camera'],
    ['NotReadableError', 'camera-in-use'],
    ['OverconstrainedError', 'constraints'],
    // No capture backend (a kiosk WebView, Chromium's headless shell): no "Try again".
    ['NotSupportedError', 'unsupported'],
  ])('reports %s as %s', async (name, kind) => {
    install({ permission: 'prompt', getUserMedia: () => Promise.reject(mediaError(name)) })
    const { result } = renderHook(() => useCameraStream({ autoStart: true }))

    act(() => result.current.start())
    await waitFor(() => expect(result.current.error?.kind).toBe(kind))
    expect(result.current.status).toBe('error')
    expect(result.current.stream).toBeNull()
  })

  it('reports an insecure page without asking for the camera', async () => {
    const { getUserMedia } = install({ permission: 'granted' })
    // jsdom does not define isSecureContext; a plain-http LAN address is an insecure context.
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
    try {
      const { result } = renderHook(() => useCameraStream({ autoStart: true }))
      await waitFor(() => expect(result.current.error?.kind).toBe('insecure-context'))
      expect(getUserMedia).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(window, 'isSecureContext')
    }
  })

  it('reports a browser without camera support', async () => {
    install({ permission: 'granted', mediaDevices: false })
    const { result } = renderHook(() => useCameraStream({ autoStart: true }))

    await waitFor(() => expect(result.current.error?.kind).toBe('unsupported'))
  })

  it('reports a camera that stops on its own (unplugged, access revoked)', async () => {
    const fake = install({ permission: 'granted' })
    const { result } = renderHook(() => useCameraStream({ autoStart: true }))
    await waitFor(() => expect(result.current.status).toBe('live'))

    act(() => fake.tracks[0]?.emit('ended'))
    expect(result.current.error?.kind).toBe('camera-ended')
    expect(fake.tracks[0]?.stop).toHaveBeenCalled()
  })

  it('shows a blocking reason (the QR reader failed to load) instead of starting', async () => {
    const { getUserMedia } = install({ permission: 'granted' })
    const { result } = renderHook(() => useCameraStream({ autoStart: true, blockedBy: CAMERA_ERRORS['decoder-unavailable'] }))

    await act(async () => {})
    expect(result.current.status).toBe('error')
    expect(result.current.error?.kind).toBe('decoder-unavailable')
    expect(getUserMedia).not.toHaveBeenCalled()
  })
})

describe('useCameraStream: camera picker', () => {
  it('uses the remembered camera, exactly', async () => {
    storeCameraDeviceId('camera-front')
    const { getUserMedia } = install({ permission: 'granted' })
    const { result } = renderHook(() => useCameraStream({ autoStart: true }))

    await waitFor(() => expect(result.current.status).toBe('live'))
    expect(getUserMedia).toHaveBeenCalledWith(videoConstraints('camera-front'))
  })

  it('falls back to the default camera when the remembered one is gone, and forgets it', async () => {
    storeCameraDeviceId('camera-gone')
    const track = fakeTrack('camera-rear')
    const { getUserMedia } = install({
      permission: 'granted',
      getUserMedia: (constraints) =>
        (constraints.video as MediaTrackConstraints).deviceId
          ? Promise.reject(mediaError('OverconstrainedError'))
          : Promise.resolve(fakeStream(track)),
    })
    const { result } = renderHook(() => useCameraStream({ autoStart: true }))

    await waitFor(() => expect(result.current.status).toBe('live'))
    expect(getUserMedia).toHaveBeenNthCalledWith(1, videoConstraints('camera-gone'))
    expect(getUserMedia).toHaveBeenNthCalledWith(2, videoConstraints(null))
    expect(readCameraDeviceId()).toBeNull()
    expect(result.current.deviceId).toBe('camera-rear')
  })

  it('switches cameras, stops the previous one and remembers the choice', async () => {
    const fake = install({ permission: 'granted' })
    const { result } = renderHook(() => useCameraStream({ autoStart: true }))
    await waitFor(() => expect(result.current.status).toBe('live'))

    act(() => result.current.selectDevice('camera-front'))
    await waitFor(() => expect(fake.getUserMedia).toHaveBeenCalledTimes(2))
    expect(fake.getUserMedia).toHaveBeenLastCalledWith(videoConstraints('camera-front'))
    expect(fake.tracks[0]?.stop).toHaveBeenCalled()
    expect(readCameraDeviceId()).toBe('camera-front')
  })

  it('remembers nothing when storage throws, and still works', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    const fake = install({ permission: 'granted' })
    const { result } = renderHook(() => useCameraStream({ autoStart: true }))
    await waitFor(() => expect(result.current.status).toBe('live'))

    act(() => result.current.selectDevice('camera-front'))
    await waitFor(() => expect(fake.getUserMedia).toHaveBeenLastCalledWith(videoConstraints('camera-front')))
    await waitFor(() => expect(result.current.status).toBe('live'))
  })
})

describe('useCameraStream: one stream for the session', () => {
  it('stops the tracks when the screen unmounts (route change)', async () => {
    const fake = install({ permission: 'granted' })
    const { result, unmount } = renderHook(() => useCameraStream({ autoStart: true }))
    await waitFor(() => expect(result.current.status).toBe('live'))

    unmount()
    expect(fake.tracks[0]?.stop).toHaveBeenCalledOnce()
  })

  it('stops a stream that arrives after the screen was left', async () => {
    const pending = deferred<MediaStream>()
    const track = fakeTrack()
    install({ permission: 'granted', getUserMedia: () => pending.promise })
    const { unmount } = renderHook(() => useCameraStream({ autoStart: true }))
    await act(async () => {})

    unmount()
    await act(async () => pending.resolve(fakeStream(track)))
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('stops the tracks while the page is hidden and restarts them when it is shown', async () => {
    const fake = install({ permission: 'granted' })
    const { result } = renderHook(() => useCameraStream({ autoStart: true }))
    await waitFor(() => expect(result.current.status).toBe('live'))

    act(() => setVisibility('hidden'))
    expect(fake.tracks[0]?.stop).toHaveBeenCalledOnce()
    expect(result.current.stream).toBeNull()
    await act(async () => {})
    expect(fake.getUserMedia).toHaveBeenCalledOnce()

    act(() => setVisibility('visible'))
    await waitFor(() => expect(result.current.status).toBe('live'))
    expect(fake.getUserMedia).toHaveBeenCalledTimes(2)
  })

  it('stays off after the user turned it off', async () => {
    const fake = install({ permission: 'granted' })
    const { result } = renderHook(() => useCameraStream({ autoStart: true }))
    await waitFor(() => expect(result.current.status).toBe('live'))

    act(() => result.current.stop())
    expect(result.current.status).toBe('idle')
    expect(fake.tracks[0]?.stop).toHaveBeenCalledOnce()
    await act(async () => {})
    expect(fake.getUserMedia).toHaveBeenCalledOnce()
  })
})

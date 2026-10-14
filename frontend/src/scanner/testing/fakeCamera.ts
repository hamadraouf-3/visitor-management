import { vi } from 'vitest'

/**
 * Test doubles for the camera APIs jsdom lacks (Media Capture and Streams, Permissions). Install
 * them per test; `restore()` removes them again. Every fake records what the code asked for.
 */

type Listener = () => void

export interface FakeTrack {
  stop: ReturnType<typeof vi.fn<() => void>>
  getSettings: () => { deviceId: string }
  addEventListener: (type: string, listener: Listener) => void
  removeEventListener: (type: string, listener: Listener) => void
  /** Fires an event of the track (e.g. 'ended' when the camera is unplugged). */
  emit: (type: string) => void
}

export function fakeTrack(deviceId = 'camera-rear'): FakeTrack {
  const listeners = new Map<string, Set<Listener>>()
  return {
    stop: vi.fn<() => void>(),
    getSettings: () => ({ deviceId }),
    addEventListener: (type, listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)?.add(listener)
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
    emit: (type) => {
      for (const listener of listeners.get(type) ?? []) listener()
    },
  }
}

export function fakeStream(track: FakeTrack = fakeTrack()): MediaStream {
  return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream
}

/** A DOMException-like rejection with the given name (what getUserMedia rejects with). */
export function mediaError(name: string): Error {
  const error = new Error(`${name} (test)`)
  error.name = name
  return error
}

export interface FakeCameraOptions {
  /** Permissions API answer for "camera"; null = the API is missing. */
  permission?: PermissionState | null
  /** What getUserMedia does; defaults to a new stream with a new track per call. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  devices?: { deviceId: string; label: string }[]
  /** false: no `navigator.mediaDevices` at all (unsupported browser). */
  mediaDevices?: boolean
}

export interface FakeCamera {
  getUserMedia: ReturnType<typeof vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>>
  /** Tracks handed out by the default getUserMedia, in order. */
  tracks: FakeTrack[]
  /** Changes the permission and fires its `change` event. */
  setPermission: (state: PermissionState) => void
  restore: () => void
}

/** Installs fake `navigator.mediaDevices` and `navigator.permissions`, and makes `<video>` look playable. */
export function installFakeCamera({
  permission = 'granted',
  getUserMedia,
  devices = [{ deviceId: 'camera-rear', label: 'Back camera' }],
  mediaDevices = true,
}: FakeCameraOptions = {}): FakeCamera {
  const tracks: FakeTrack[] = []
  const getUserMediaMock = vi.fn<(constraints: MediaStreamConstraints) => Promise<MediaStream>>(
    getUserMedia ??
      (() => {
        const track = fakeTrack()
        tracks.push(track)
        return Promise.resolve(fakeStream(track))
      }),
  )

  if (mediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: getUserMediaMock,
        enumerateDevices: vi.fn<() => Promise<Partial<MediaDeviceInfo>[]>>(() =>
          Promise.resolve(devices.map((device) => ({ ...device, kind: 'videoinput' as const, groupId: '' }))),
        ),
        addEventListener: vi.fn<(type: string, listener: Listener) => void>(),
        removeEventListener: vi.fn<(type: string, listener: Listener) => void>(),
      },
    })
  }

  const permissionListeners = new Set<Listener>()
  const status = {
    state: permission ?? 'prompt',
    addEventListener: (_type: string, listener: Listener) => permissionListeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => permissionListeners.delete(listener),
  }
  if (permission !== null) {
    Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: vi.fn<() => Promise<typeof status>>(() => Promise.resolve(status)) } })
  }

  // jsdom has no media pipeline: a stream "plays" and its first frame is available at once.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4)
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1280)

  return {
    getUserMedia: getUserMediaMock,
    tracks,
    setPermission: (state) => {
      status.state = state
      for (const listener of permissionListeners) listener()
    },
    restore: () => {
      Reflect.deleteProperty(navigator, 'mediaDevices')
      Reflect.deleteProperty(navigator, 'permissions')
    },
  }
}

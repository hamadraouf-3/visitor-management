import { useCallback, useEffect, useRef, useState } from 'react'
import { i18n } from '../i18n'
import {
  CAMERA_ERRORS,
  cameraEnvironmentError,
  cameraErrorFromException,
  isDeviceSpecificFailure,
  readCameraEnvironment,
  type CameraError,
} from './cameraErrors'
import { markCameraUsed, readCameraDeviceId, readCameraUsedBefore, storeCameraDeviceId } from './preferences'

export type CameraStatus = 'idle' | 'starting' | 'live' | 'error'

export interface CameraDevice {
  deviceId: string
  label: string
}

export interface CameraState {
  status: CameraStatus
  error: CameraError | null
  stream: MediaStream | null
  /** Video inputs; labels are known only once camera access was granted. */
  devices: CameraDevice[]
  /** The camera in use (read from the live track), else the remembered choice. */
  deviceId: string | null
}

export interface CameraControls extends CameraState {
  /** Starts (or restarts) the camera; "Start camera" and "Try again". */
  start: () => void
  /** Stops the tracks; the camera then does not auto-start again in this session. */
  stop: () => void
  /** Switches to another camera and remembers the choice on this device. */
  selectDevice: (deviceId: string) => void
}

export interface UseCameraStreamOptions {
  /**
   * Start without a click when camera access was granted before: the Permissions API says
   * "granted", or, where it cannot tell, the camera has started on this device before (§10).
   */
  autoStart: boolean
  /** Shown as the camera's error, and nothing starts, e.g. when the QR decoder failed to load. */
  blockedBy?: CameraError | null
}

/**
 * §10: `facingMode` is only ever `ideal` (never `exact`), so a device without a rear camera
 * still gets one. A camera the user picked is requested exactly; if it has gone away the
 * request falls back to these defaults. The size is a hint for a sharper picture of the code.
 */
export function videoConstraints(deviceId: string | null): MediaStreamConstraints {
  const size = { width: { ideal: 1280 }, height: { ideal: 720 } }
  return {
    audio: false,
    video: deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: { ideal: 'environment' }, ...size },
  }
}

type PermissionAnswer = PermissionState | 'unknown'

/** "camera" is not a PermissionName in every browser (Firefox before 131); those throw and answer unknown. */
async function queryCameraPermission(): Promise<{ state: PermissionAnswer; status: PermissionStatus | null }> {
  try {
    if (!navigator.permissions?.query) return { state: 'unknown', status: null }
    const status = await navigator.permissions.query({ name: 'camera' as PermissionName })
    return { state: status.state, status }
  } catch {
    return { state: 'unknown', status: null }
  }
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop()
}

async function listCameras(): Promise<CameraDevice[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .filter((device) => device.kind === 'videoinput' && device.deviceId)
      .map((device, index) => ({ deviceId: device.deviceId, label: device.label || i18n.t('camera.numbered', { ns: 'reception', number: index + 1 }) }))
  } catch {
    return []
  }
}

const INITIAL_STATE: CameraState = { status: 'idle', error: null, stream: null, devices: [], deviceId: null }

/**
 * The reception camera (§10). One `MediaStream` is kept open for the whole session: the
 * scanner only pauses decoding between scans. The tracks are stopped when the component
 * unmounts (route change) and while the page is hidden, and restarted when it is shown again.
 * A track that ends on its own (camera unplugged, access revoked) is reported as an error.
 */
export function useCameraStream({ autoStart, blockedBy = null }: UseCameraStreamOptions): CameraControls {
  const [state, setState] = useState<CameraState>(() => ({ ...INITIAL_STATE, deviceId: readCameraDeviceId() }))
  const streamRef = useRef<MediaStream | null>(null)
  // Every start or stop bumps the generation; a getUserMedia answer for an older one is discarded.
  const generation = useRef(0)
  const userStopped = useRef(false)
  const resumeWhenVisible = useRef(false)
  const statusRef = useRef<CameraStatus>(state.status)
  const errorRef = useRef<CameraError | null>(null)
  const deviceRef = useRef<string | null>(state.deviceId)

  const update = useCallback((next: Partial<CameraState>) => {
    if (next.status) statusRef.current = next.status
    if ('error' in next) errorRef.current = next.error ?? null
    if ('deviceId' in next) deviceRef.current = next.deviceId ?? null
    setState((current) => ({ ...current, ...next }))
  }, [])

  const releaseStream = useCallback(() => {
    stopStream(streamRef.current)
    streamRef.current = null
  }, [])

  const refreshDevices = useCallback(async () => {
    const devices = await listCameras()
    setState((current) => ({ ...current, devices }))
  }, [])

  const fail = useCallback(
    (error: CameraError) => {
      releaseStream()
      update({ status: 'error', error, stream: null })
    },
    [releaseStream, update],
  )

  const startWith = useCallback(
    async (preferred: string | null) => {
      const environmentError = cameraEnvironmentError(readCameraEnvironment())
      if (environmentError) {
        fail(environmentError)
        return
      }
      generation.current += 1
      const run = generation.current
      releaseStream()
      update({ status: 'starting', error: null, stream: null })

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia(videoConstraints(preferred))
      } catch (error) {
        if (run !== generation.current) return
        if (!preferred || !isDeviceSpecificFailure(error)) {
          fail(cameraErrorFromException(error))
          return
        }
        // The remembered camera is gone or cannot deliver video: forget it, use the default one.
        storeCameraDeviceId(null)
        try {
          stream = await navigator.mediaDevices.getUserMedia(videoConstraints(null))
        } catch (fallbackError) {
          if (run === generation.current) fail(cameraErrorFromException(fallbackError))
          return
        }
      }

      if (run !== generation.current) {
        // Stopped, restarted or unmounted while the browser was asking: this stream is not wanted.
        stopStream(stream)
        return
      }
      streamRef.current = stream
      markCameraUsed()
      const track = stream.getVideoTracks()[0]
      track?.addEventListener('ended', () => {
        if (streamRef.current === stream) fail(CAMERA_ERRORS['camera-ended'])
      })
      update({ status: 'live', error: null, stream, deviceId: track?.getSettings?.().deviceId || preferred })
      void refreshDevices()
    },
    [fail, refreshDevices, releaseStream, update],
  )

  const start = useCallback(() => {
    userStopped.current = false
    void startWith(deviceRef.current)
  }, [startWith])

  const stop = useCallback(() => {
    userStopped.current = true
    generation.current += 1
    releaseStream()
    update({ status: 'idle', error: null, stream: null })
  }, [releaseStream, update])

  const selectDevice = useCallback(
    (deviceId: string) => {
      storeCameraDeviceId(deviceId)
      userStopped.current = false
      update({ deviceId })
      void startWith(deviceId)
    },
    [startWith, update],
  )

  const blocked = blockedBy !== null

  // A camera that cannot be used for scanning is not kept running.
  useEffect(() => {
    if (!blocked || !streamRef.current) return
    generation.current += 1
    releaseStream()
    update({ status: 'idle', stream: null })
  }, [blocked, releaseStream, update])

  // Auto-start (§10): only while the page is visible, the camera is idle and the user has not
  // stopped it. A permission the browser reports as denied is shown right away.
  useEffect(() => {
    if (!autoStart || blocked || state.status !== 'idle' || userStopped.current) return
    if (document.visibilityState === 'hidden') return
    let cancelled = false
    void (async () => {
      const environmentError = cameraEnvironmentError(readCameraEnvironment())
      if (environmentError) {
        if (!cancelled) fail(environmentError)
        return
      }
      const permission = await queryCameraPermission()
      if (cancelled || statusRef.current !== 'idle') return
      if (permission.state === 'denied') fail(CAMERA_ERRORS['permission-denied'])
      else if (permission.state === 'granted' || (permission.state === 'unknown' && readCameraUsedBefore())) {
        void startWith(deviceRef.current)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [autoStart, blocked, state.status, fail, startWith])

  // Access granted later in the browser's own UI: start without another click.
  const autoStartRef = useRef(autoStart && !blocked)
  useEffect(() => {
    autoStartRef.current = autoStart && !blocked
  })
  useEffect(() => {
    let status: PermissionStatus | null = null
    let cancelled = false
    const onChange = () => {
      if (status?.state !== 'granted' || userStopped.current || !autoStartRef.current) return
      const waiting = statusRef.current === 'idle' || errorRef.current?.kind === 'permission-denied'
      if (waiting) void startWith(deviceRef.current)
    }
    void queryCameraPermission().then((answer) => {
      if (cancelled || !answer.status) return
      status = answer.status
      status.addEventListener('change', onChange)
    })
    return () => {
      cancelled = true
      status?.removeEventListener('change', onChange)
    }
  }, [startWith])

  // §10: stop the tracks while the page is hidden; restart them when it is shown again.
  useEffect(() => {
    const hide = () => {
      if (!streamRef.current && statusRef.current !== 'starting') return
      resumeWhenVisible.current = true
      generation.current += 1
      releaseStream()
      update({ status: 'idle', stream: null })
    }
    const show = () => {
      if (!resumeWhenVisible.current || document.visibilityState === 'hidden') return
      resumeWhenVisible.current = false
      if (!userStopped.current) void startWith(deviceRef.current)
    }
    const onVisibilityChange = () => (document.visibilityState === 'hidden' ? hide() : show())
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', show)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', hide)
      window.removeEventListener('pageshow', show)
    }
  }, [releaseStream, startWith, update])

  // A camera plugged in or out changes the picker.
  useEffect(() => {
    const mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
    if (!mediaDevices?.addEventListener) return
    const onDeviceChange = () => void refreshDevices()
    mediaDevices.addEventListener('devicechange', onDeviceChange)
    return () => mediaDevices.removeEventListener('devicechange', onDeviceChange)
  }, [refreshDevices])

  // Leaving the screen (route change, sign-out) stops the camera.
  useEffect(
    () => () => {
      generation.current += 1
      releaseStream()
    },
    [releaseStream],
  )

  const error = blockedBy ?? state.error
  return {
    ...state,
    status: blockedBy ? 'error' : state.status,
    error,
    start,
    stop,
    selectDevice,
  }
}

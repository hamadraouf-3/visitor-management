import { i18n } from '../i18n'

/**
 * Camera failures in words a receptionist can act on (§10 "camera errors with clear
 * messages"). Pure: `getUserMedia` rejections are mapped by their DOMException `name`, and
 * the environment checks run before any camera request. The words are read from the
 * `reception` catalog when read, so an error on screen follows a language switch.
 */

export type CameraErrorKind =
  | 'permission-denied'
  | 'no-camera'
  | 'camera-in-use'
  | 'constraints'
  | 'camera-ended'
  | 'insecure-context'
  | 'unsupported'
  | 'decoder-unavailable'
  | 'unknown'

export interface CameraError {
  kind: CameraErrorKind
  title: string
  message: string
  /** "Try again" can help without leaving the page (otherwise the fix is elsewhere, e.g. HTTPS). */
  retryable: boolean
}

const t = i18n.getFixedT(null, 'reception')

/** The catalog key of each kind (`camera.errors.<key>.title` / `.message`). */
const ERROR_KEYS = {
  'permission-denied': 'permissionDenied',
  'no-camera': 'noCamera',
  'camera-in-use': 'inUse',
  constraints: 'constraints',
  'camera-ended': 'ended',
  'insecure-context': 'insecure',
  unsupported: 'unsupported',
  'decoder-unavailable': 'decoder',
  unknown: 'unknown',
} as const satisfies Record<CameraErrorKind, string>

/** An error whose title and message are read in the UI language when read; one object per kind. */
function cameraError(kind: CameraErrorKind, retryable: boolean): CameraError {
  const key = ERROR_KEYS[kind]
  return {
    kind,
    get title() {
      return t(`camera.errors.${key}.title`)
    },
    get message() {
      return t(`camera.errors.${key}.message`)
    },
    retryable,
  }
}

export const CAMERA_ERRORS: Record<CameraErrorKind, CameraError> = {
  'permission-denied': cameraError('permission-denied', true),
  'no-camera': cameraError('no-camera', true),
  'camera-in-use': cameraError('camera-in-use', true),
  constraints: cameraError('constraints', true),
  'camera-ended': cameraError('camera-ended', true),
  'insecure-context': cameraError('insecure-context', false),
  unsupported: cameraError('unsupported', false),
  'decoder-unavailable': cameraError('decoder-unavailable', false),
  unknown: cameraError('unknown', true),
}

/**
 * getUserMedia rejection names (Media Capture and Streams), including the legacy Chrome and
 * Firefox names still seen on older devices.
 */
const KIND_BY_ERROR_NAME: Record<string, CameraErrorKind> = {
  NotAllowedError: 'permission-denied',
  PermissionDeniedError: 'permission-denied',
  // Firefox reports a camera blocked by a Permissions-Policy or a sandbox as SecurityError.
  SecurityError: 'permission-denied',
  NotFoundError: 'no-camera',
  DevicesNotFoundError: 'no-camera',
  NotReadableError: 'camera-in-use',
  TrackStartError: 'camera-in-use',
  // Chrome on Windows reports a camera another process holds as AbortError ("Timeout starting video source").
  AbortError: 'camera-in-use',
  OverconstrainedError: 'constraints',
  ConstraintNotSatisfiedError: 'constraints',
  TypeError: 'unsupported',
  // The browser has no capture backend (some kiosk WebViews, Chromium's headless shell): neither
  // a retry nor a reload can help, so this is "unsupported", not the generic retryable failure.
  NotSupportedError: 'unsupported',
}

function errorName(error: unknown): string | null {
  if (error && typeof error === 'object' && 'name' in error && typeof (error as { name: unknown }).name === 'string') {
    return (error as { name: string }).name
  }
  return null
}

/** The camera error for a rejected `getUserMedia` (or a failed `play()` of the preview). */
export function cameraErrorFromException(error: unknown): CameraError {
  const name = errorName(error)
  const kind = name ? KIND_BY_ERROR_NAME[name] : undefined
  return CAMERA_ERRORS[kind ?? 'unknown']
}

/** Whether a rejection means the requested device itself is unusable (try the default camera instead). */
export function isDeviceSpecificFailure(error: unknown): boolean {
  const name = errorName(error)
  return name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError' || name === 'NotFoundError'
}

export interface CameraEnvironment {
  /** `window.isSecureContext`; undefined (older engines, tests) counts as secure. */
  isSecureContext: boolean | undefined
  hasGetUserMedia: boolean
}

/** Reads the environment from the browser globals. */
export function readCameraEnvironment(): CameraEnvironment {
  return {
    isSecureContext: typeof window === 'undefined' ? undefined : window.isSecureContext,
    hasGetUserMedia: typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function',
  }
}

/**
 * Why the camera cannot be used at all here, or null. Checked before any request: browsers
 * hide `navigator.mediaDevices` outside secure contexts, so "insecure" must be told apart
 * from "unsupported" first.
 */
export function cameraEnvironmentError(environment: CameraEnvironment): CameraError | null {
  if (environment.isSecureContext === false) return CAMERA_ERRORS['insecure-context']
  if (!environment.hasGetUserMedia) return CAMERA_ERRORS.unsupported
  return null
}

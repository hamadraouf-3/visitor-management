import { describe, expect, it } from 'vitest'
import { CAMERA_ERRORS, cameraEnvironmentError, cameraErrorFromException, isDeviceSpecificFailure } from './cameraErrors'
import { mediaError } from './testing/fakeCamera'

describe('cameraErrorFromException', () => {
  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['PermissionDeniedError', 'permission-denied'],
    ['SecurityError', 'permission-denied'],
    ['NotFoundError', 'no-camera'],
    ['DevicesNotFoundError', 'no-camera'],
    ['NotReadableError', 'camera-in-use'],
    ['TrackStartError', 'camera-in-use'],
    ['AbortError', 'camera-in-use'],
    ['OverconstrainedError', 'constraints'],
    ['TypeError', 'unsupported'],
    ['NotSupportedError', 'unsupported'],
    ['SomethingNew', 'unknown'],
  ])('maps %s to %s', (name, kind) => {
    expect(cameraErrorFromException(mediaError(name)).kind).toBe(kind)
  })

  it('maps values that are not errors to the generic failure', () => {
    expect(cameraErrorFromException('boom').kind).toBe('unknown')
    expect(cameraErrorFromException(null).kind).toBe('unknown')
  })

  it('tells the receptionist what to do, and offers a retry only where one can help', () => {
    expect(CAMERA_ERRORS['permission-denied'].message).toMatch(/Allow camera access.*Try again/)
    expect(CAMERA_ERRORS['camera-in-use'].message).toMatch(/Another app or browser tab/)
    expect(CAMERA_ERRORS['insecure-context'].message).toMatch(/HTTPS/)
    expect(CAMERA_ERRORS['insecure-context'].retryable).toBe(false)
    expect(CAMERA_ERRORS.unsupported.retryable).toBe(false)
    expect(CAMERA_ERRORS['decoder-unavailable'].retryable).toBe(false)
    expect(CAMERA_ERRORS['no-camera'].retryable).toBe(true)
    // Every message names the fallback that always works, except the in-use one (it is temporary).
    for (const kind of ['permission-denied', 'no-camera', 'insecure-context', 'unsupported', 'decoder-unavailable'] as const) {
      expect(CAMERA_ERRORS[kind].message).toContain('handheld scanner')
    }
  })
})

describe('isDeviceSpecificFailure', () => {
  it('is true only when the requested device itself is unusable', () => {
    expect(isDeviceSpecificFailure(mediaError('OverconstrainedError'))).toBe(true)
    expect(isDeviceSpecificFailure(mediaError('NotFoundError'))).toBe(true)
    expect(isDeviceSpecificFailure(mediaError('NotAllowedError'))).toBe(false)
    expect(isDeviceSpecificFailure(mediaError('NotReadableError'))).toBe(false)
  })
})

describe('cameraEnvironmentError', () => {
  it('reports an insecure page before anything else (browsers hide the camera API there)', () => {
    expect(cameraEnvironmentError({ isSecureContext: false, hasGetUserMedia: false })?.kind).toBe('insecure-context')
  })

  it('reports a browser without getUserMedia as unsupported', () => {
    expect(cameraEnvironmentError({ isSecureContext: true, hasGetUserMedia: false })?.kind).toBe('unsupported')
  })

  it('accepts a secure page with getUserMedia, and an engine that does not report the context', () => {
    expect(cameraEnvironmentError({ isSecureContext: true, hasGetUserMedia: true })).toBeNull()
    expect(cameraEnvironmentError({ isSecureContext: undefined, hasGetUserMedia: true })).toBeNull()
  })
})

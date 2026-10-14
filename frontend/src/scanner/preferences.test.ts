import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  markCameraUsed,
  readCameraDeviceId,
  readCameraUsedBefore,
  readSuccessFeedback,
  storeCameraDeviceId,
  storeSuccessFeedback,
} from './preferences'

describe('scanner preferences', () => {
  afterEach(() => {
    window.localStorage.clear()
  })

  it('remembers the chosen camera and forgets it on request', () => {
    expect(readCameraDeviceId()).toBeNull()
    storeCameraDeviceId('camera-front')
    expect(readCameraDeviceId()).toBe('camera-front')
    storeCameraDeviceId(null)
    expect(readCameraDeviceId()).toBeNull()
  })

  it('remembers that the camera started on this device', () => {
    expect(readCameraUsedBefore()).toBe(false)
    markCameraUsed()
    expect(readCameraUsedBefore()).toBe(true)
  })

  it('keeps the success sound off by default (§10)', () => {
    expect(readSuccessFeedback()).toBe(false)
    storeSuccessFeedback(true)
    expect(readSuccessFeedback()).toBe(true)
    storeSuccessFeedback(false)
    expect(readSuccessFeedback()).toBe(false)
  })

  it('treats storage that throws (private mode, blocked site data) as "no preference"', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })

    expect(() => storeCameraDeviceId('camera-front')).not.toThrow()
    expect(() => storeCameraDeviceId(null)).not.toThrow()
    expect(() => markCameraUsed()).not.toThrow()
    expect(() => storeSuccessFeedback(true)).not.toThrow()
    expect(readCameraDeviceId()).toBeNull()
    expect(readCameraUsedBefore()).toBe(false)
    expect(readSuccessFeedback()).toBe(false)
  })
})

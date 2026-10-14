/**
 * Per-device scanner preferences in localStorage. Storage can be unavailable or throw (private
 * browsing, blocked site data, quota), so every access is guarded and a failure simply means
 * "no preference": the scanner then behaves as on first use.
 */

const CAMERA_DEVICE_KEY = 'vms.reception.cameraDeviceId'
const CAMERA_USED_KEY = 'vms.reception.cameraUsed'
const SUCCESS_FEEDBACK_KEY = 'vms.reception.successFeedback'

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Not persisted; the choice still applies until the page is reloaded.
  }
}

/** The camera the user picked on this device, if any. */
export function readCameraDeviceId(): string | null {
  return read(CAMERA_DEVICE_KEY) || null
}

export function storeCameraDeviceId(deviceId: string | null): void {
  write(CAMERA_DEVICE_KEY, deviceId)
}

/**
 * Whether the camera has started on this device before. Used to auto-start where the
 * Permissions API cannot tell whether camera access was granted (§10 "auto-start once
 * permission was granted before").
 */
export function readCameraUsedBefore(): boolean {
  return read(CAMERA_USED_KEY) === '1'
}

export function markCameraUsed(): void {
  write(CAMERA_USED_KEY, '1')
}

/** Beep and vibration after a successful check-in or check-out; off by default (§10). */
export function readSuccessFeedback(): boolean {
  return read(SUCCESS_FEEDBACK_KEY) === 'on'
}

export function storeSuccessFeedback(enabled: boolean): void {
  write(SUCCESS_FEEDBACK_KEY, enabled ? 'on' : null)
}

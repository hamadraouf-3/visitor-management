import { useCallback, useSyncExternalStore } from 'react'

/*
 * How this viewer is told of a new tracking alert (Phase 16), on this device: «صوت التنبيه» / "Alert sound"
 * (on by default) and «إشعارات المتصفح» / "Browser notifications" (off by default; the browser asks for its
 * permission when turned on). Kept in the browser's local storage under the person's id, so two people
 * sharing a reception tablet each keep their own. Storage may be unavailable (a private window, blocked site
 * data): every read and write is guarded, and the defaults then apply for the page's life.
 */

export interface AlertPreferences {
  sound: boolean
  notifications: boolean
}

export type AlertPreference = keyof AlertPreferences

export const DEFAULT_ALERT_PREFERENCES: AlertPreferences = { sound: true, notifications: false }

const STORAGE_PREFIX = 'vms.trackingAlerts'

function storageKey(userId: string, name: AlertPreference): string {
  return `${STORAGE_PREFIX}.${name}.${userId}`
}

/** What this tab chose while storage refused it: the choice still holds until the page is left. */
const unsaved = new Map<string, boolean>()
const listeners = new Set<() => void>()

function readOne(userId: string, name: AlertPreference): boolean {
  const key = storageKey(userId, name)
  const fallback = unsaved.get(key) ?? DEFAULT_ALERT_PREFERENCES[name]
  try {
    const stored = window.localStorage.getItem(key)
    return stored === null ? fallback : stored === '1'
  } catch {
    return fallback
  }
}

export function readAlertPreferences(userId: string): AlertPreferences {
  return { sound: readOne(userId, 'sound'), notifications: readOne(userId, 'notifications') }
}

export function writeAlertPreference(userId: string, name: AlertPreference, value: boolean): void {
  const key = storageKey(userId, name)
  unsaved.set(key, value)
  try {
    window.localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // Storage refused (a private window, blocked site data): the choice holds for this page's life.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Another tab of the same browser changed it.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(STORAGE_PREFIX)) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** The viewer's two choices, kept in step with every change (this tab's or another's), and a setter. */
export function useAlertPreferences(userId: string): [AlertPreferences, (name: AlertPreference, value: boolean) => void] {
  // A primitive snapshot (the two choices as one string), so an unchanged read is the same value.
  const snapshot = useSyncExternalStore(subscribe, () => {
    const preferences = readAlertPreferences(userId)
    return `${Number(preferences.sound)}${Number(preferences.notifications)}`
  })
  const set = useCallback((name: AlertPreference, value: boolean) => writeAlertPreference(userId, name, value), [userId])
  return [{ sound: snapshot[0] === '1', notifications: snapshot[1] === '1' }, set]
}

/* Browser notifications ----------------------------------------------------------------------------- */

export type NotificationSupport = 'unsupported' | NotificationPermission

/** Whether the browser can show notifications here, and what the viewer allowed. */
export function notificationSupport(): NotificationSupport {
  try {
    return typeof window.Notification === 'function' ? window.Notification.permission : 'unsupported'
  } catch {
    return 'unsupported'
  }
}

/** Asks the browser for its permission (a prompt the viewer answers); what holds afterwards. */
export async function requestNotificationPermission(): Promise<NotificationSupport> {
  if (notificationSupport() === 'unsupported') return 'unsupported'
  try {
    return await window.Notification.requestPermission()
  } catch {
    return notificationSupport()
  }
}

/** The notifications this page showed and the system still holds: closed when the watcher goes (F16-39). */
const shownNotifications = new Set<Notification>()

/**
 * A notification of the operating system, when the viewer turned them on and the browser allows them. Some
 * browsers (Chrome on Android) refuse the constructor outside a service worker: nothing is shown there, the
 * toast and the sound still are. Kept until clicked, closed, or {@link closeBrowserNotifications}.
 */
export function showBrowserNotification(title: string, { body, tag, lang, onClick }: { body?: string; tag: string; lang: string; onClick: () => void }): void {
  if (notificationSupport() !== 'granted') return
  try {
    const notification = new window.Notification(title, { body, tag, lang })
    shownNotifications.add(notification)
    notification.addEventListener('close', () => shownNotifications.delete(notification))
    notification.addEventListener('click', () => {
      window.focus()
      onClick()
      notification.close()
    })
  } catch {
    // Not available on this browser outside a service worker.
  }
}

/**
 * Closes every notification this page showed (each names a visitor and where they are): the session that saw them
 * is over, and on a shared device the next person must not find them in the system's notification centre.
 */
export function closeBrowserNotifications(): void {
  for (const notification of shownNotifications) {
    try {
      notification.close()
    } catch {
      // Already gone.
    }
  }
  shownNotifications.clear()
}

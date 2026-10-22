import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { closeBrowserNotifications, DEFAULT_ALERT_PREFERENCES, notificationSupport, readAlertPreferences, requestNotificationPermission, showBrowserNotification, writeAlertPreference } from './alertPreferences'

afterEach(() => {
  window.localStorage.clear()
})

interface ShownNotification {
  listeners: Map<string, () => void>
  close: Mock<() => void>
}

/** A browser's Notification whose instances keep their listeners, with a spied close; `construct` may refuse. */
function stubNotification(permission: NotificationPermission, construct: (title: string) => void = () => undefined): ShownNotification[] {
  const shown: ShownNotification[] = []
  vi.stubGlobal(
    'Notification',
    Object.assign(
      class {
        listeners = new Map<string, () => void>()
        close = vi.fn<() => void>()
        constructor(title: string) {
          construct(title)
          shown.push(this)
        }
        addEventListener(type: string, listener: () => void) {
          this.listeners.set(type, listener)
        }
      },
      { permission, requestPermission: vi.fn<() => Promise<NotificationPermission>>() },
    ),
  )
  return shown
}

describe('the viewer’s alert settings', () => {
  it('start with the sound on and the browser notifications off', () => {
    expect(DEFAULT_ALERT_PREFERENCES).toEqual({ sound: true, notifications: false })
    expect(readAlertPreferences('u-new')).toEqual({ sound: true, notifications: false })
  })

  it('are kept per person in the browser’s storage', () => {
    writeAlertPreference('u1', 'sound', false)
    writeAlertPreference('u1', 'notifications', true)
    expect(readAlertPreferences('u1')).toEqual({ sound: false, notifications: true })
    expect(readAlertPreferences('u2')).toEqual({ sound: true, notifications: false })
    expect(window.localStorage.getItem('vms.trackingAlerts.sound.u1')).toBe('0')
  })

  it('hold for the page’s life when the storage refuses them, and never throw', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    expect(() => writeAlertPreference('u3', 'sound', false)).not.toThrow()
    expect(readAlertPreferences('u3')).toEqual({ sound: false, notifications: false })
  })
})

describe('browser notifications', () => {
  it('say when the browser has none', async () => {
    vi.stubGlobal('Notification', undefined)
    expect(notificationSupport()).toBe('unsupported')
    expect(await requestNotificationPermission()).toBe('unsupported')
  })

  it('ask the browser’s permission', async () => {
    const requestPermission = vi.fn<() => Promise<NotificationPermission>>(async () => 'granted')
    vi.stubGlobal('Notification', Object.assign(function Notification() {}, { permission: 'default', requestPermission }))
    expect(notificationSupport()).toBe('default')
    expect(await requestNotificationPermission()).toBe('granted')
    expect(requestPermission).toHaveBeenCalledOnce()
  })

  it('show nothing once the browser no longer allows them', () => {
    const shown = stubNotification('denied')
    showBrowserNotification('Alert: Omar Saleh in Floor 4 › Open office', { tag: 'a1', lang: 'en', onClick: vi.fn<() => void>() })
    expect(shown).toEqual([])
  })

  it('never throw where the browser refuses the constructor (Chrome on Android): the toast still says it', () => {
    stubNotification('granted', () => {
      throw new TypeError('Illegal constructor. Use ServiceWorkerRegistration.showNotification() instead.')
    })
    expect(() => showBrowserNotification('t', { tag: 'a1', lang: 'en', onClick: vi.fn<() => void>() })).not.toThrow()
  })

  it('on a click bring the tab forward, open the journey and close the notification', () => {
    const shown = stubNotification('granted')
    const onClick = vi.fn<() => void>()
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined)
    showBrowserNotification('t', { tag: 'a1', lang: 'en', onClick })
    shown[0]!.listeners.get('click')!()
    expect(focus).toHaveBeenCalledOnce()
    expect(onClick).toHaveBeenCalledOnce()
    expect(shown[0]!.close).toHaveBeenCalledOnce()
  })

  it('are all closed at the end of a session, except those the system already closed (F16-39)', () => {
    const shown = stubNotification('granted')
    showBrowserNotification('first', { tag: 'a1', lang: 'en', onClick: vi.fn<() => void>() })
    showBrowserNotification('second', { tag: 'a2', lang: 'en', onClick: vi.fn<() => void>() })
    shown[0]!.listeners.get('close')!()
    closeBrowserNotifications()
    expect(shown[0]!.close).not.toHaveBeenCalled()
    expect(shown[1]!.close).toHaveBeenCalledOnce()
    // Once: they are forgotten.
    closeBrowserNotifications()
    expect(shown[1]!.close).toHaveBeenCalledOnce()
  })
})

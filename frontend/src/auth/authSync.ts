/**
 * Tells the app's other tabs (same browser profile) that this tab signed in or out. All tabs
 * share one session cookie, so a sign-in or sign-out in one changes who every other tab acts as;
 * each tab holds its own query cache, which only that tab can clear (`AuthProvider` listens).
 *
 * The message carries only the kind of change: no user data. BroadcastChannel is used where it
 * exists; otherwise a `storage` event (written and removed at once, so nothing stays in storage).
 *
 * Each session realm has a channel of its own: the company session's (`subscribeToAuthChanges`,
 * `broadcastAuthChange`) and the platform owner's (Phase 11, `platformAuthSync`), so signing out
 * of one never clears the other's tabs.
 */
export type AuthChange = 'signed-in' | 'signed-out'

type AuthChangeListener = (change: AuthChange) => void

export interface AuthSync {
  /** Calls `listener` when another tab signs in or out. Returns the unsubscribe function. */
  subscribe: (listener: AuthChangeListener) => () => void
  /** Tells the other tabs that this one signed in or out. Never throws: a tab that misses it still checks the session when it is shown again. */
  broadcast: (change: AuthChange) => void
}

function isAuthChange(value: unknown): value is AuthChange {
  return value === 'signed-in' || value === 'signed-out'
}

function hasBroadcastChannel(): boolean {
  return typeof BroadcastChannel !== 'undefined'
}

/** One realm's sync: its own BroadcastChannel name and storage key. */
export function createAuthSync(channelName: string, storageKey: string): AuthSync {
  const listeners = new Set<AuthChangeListener>()
  /** One channel per tab for sending and receiving: a channel never receives its own messages. */
  let channel: BroadcastChannel | null = null

  function notify(change: unknown): void {
    if (!isAuthChange(change)) return
    for (const listener of listeners) listener(change)
  }

  function onStorage(event: StorageEvent): void {
    if (event.key !== storageKey || !event.newValue) return
    try {
      notify((JSON.parse(event.newValue) as { change?: unknown }).change)
    } catch {
      // Not ours.
    }
  }

  function connect(): void {
    if (hasBroadcastChannel()) {
      channel = new BroadcastChannel(channelName)
      channel.addEventListener('message', (event: MessageEvent<unknown>) => notify(event.data))
    } else {
      window.addEventListener('storage', onStorage)
    }
  }

  function disconnect(): void {
    if (channel) {
      channel.close()
      channel = null
    } else {
      window.removeEventListener('storage', onStorage)
    }
  }

  return {
    subscribe(listener) {
      if (listeners.size === 0) connect()
      listeners.add(listener)
      return () => {
        if (!listeners.delete(listener)) return
        if (listeners.size === 0) disconnect()
      }
    },
    broadcast(change) {
      try {
        if (hasBroadcastChannel()) {
          // This tab's own channel, so the message does not come back to this tab.
          // BroadcastChannel.postMessage has no target origin: a channel is same-origin by definition.
          // oxlint-disable-next-line unicorn/require-post-message-target-origin
          if (channel) channel.postMessage(change)
          else {
            const sender = new BroadcastChannel(channelName)
            // oxlint-disable-next-line unicorn/require-post-message-target-origin
            sender.postMessage(change)
            sender.close()
          }
          return
        }
        // A unique value, so the same change twice in a row still fires an event in other tabs.
        window.localStorage.setItem(storageKey, JSON.stringify({ change, id: `${Date.now()}-${Math.random()}` }))
        window.localStorage.removeItem(storageKey)
      } catch {
        // Storage blocked or the channel closed: the other tabs re-check the session on focus.
      }
    },
  }
}

/** The company session's sync. */
const companyAuthSync = createAuthSync('vms-auth', 'vms-auth-change')

/** The platform owner's sync (Phase 11): its own channel, so the two sessions never clear each other's tabs. */
export const platformAuthSync = createAuthSync('vms-platform-auth', 'vms-platform-auth-change')

/** Calls `listener` when another tab signs in or out of the company session. Returns the unsubscribe function. */
export function subscribeToAuthChanges(listener: AuthChangeListener): () => void {
  return companyAuthSync.subscribe(listener)
}

/** Tells the other tabs that this one signed in or out of the company session. */
export function broadcastAuthChange(change: AuthChange): void {
  companyAuthSync.broadcast(change)
}

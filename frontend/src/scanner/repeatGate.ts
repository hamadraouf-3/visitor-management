import { parsePassToken } from './parsePassToken'

/** §6/§10: the same token is ignored for 5 s. */
export const REPEAT_WINDOW_MS = 5_000

/**
 * What identifies a detection for de-duplication: the pass token (so the same pass read as a
 * URL and as a bare token is one pass), or the trimmed raw text of anything else.
 */
export function detectionKey(rawValue: string): string {
  return parsePassToken(rawValue) ?? rawValue.trim()
}

export interface RepeatGate {
  /**
   * True when a detection with this key should be handled now. False for a key seen less than
   * the window ago, whichever keys were seen in between; seeing it again restarts its window,
   * so a code held in front of the camera stays ignored until it has been away for the window.
   * Two codes in view at once (a visitor just checked in still holding up their phone while the
   * next one scans) are each handled once.
   */
  admit(key: string, now: number): boolean
  /**
   * Restarts the window of the last admitted key, e.g. when decoding resumes after its result:
   * a visitor who keeps holding the same code up must not trigger a second scan of it.
   */
  refresh(now: number): void
  /** Forgets every key (an explicit "check again" must not be swallowed). */
  reset(): void
}

export function createRepeatGate(windowMs: number = REPEAT_WINDOW_MS): RepeatGate {
  /** When each key was last seen; keys not seen for the window are dropped. */
  const lastSeenAt = new Map<string, number>()
  let lastAdmitted: string | null = null

  const forgetExpired = (now: number) => {
    for (const [key, seenAt] of lastSeenAt) if (now - seenAt >= windowMs) lastSeenAt.delete(key)
  }

  return {
    admit(key, now) {
      forgetExpired(now)
      const seenRecently = lastSeenAt.has(key)
      lastSeenAt.set(key, now)
      if (seenRecently) return false
      lastAdmitted = key
      return true
    },
    refresh(now) {
      if (lastAdmitted !== null) lastSeenAt.set(lastAdmitted, now)
    },
    reset() {
      lastSeenAt.clear()
      lastAdmitted = null
    },
  }
}

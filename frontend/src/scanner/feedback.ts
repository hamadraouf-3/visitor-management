/**
 * Optional success feedback (§10): a short beep (Web Audio) and a vibration where supported.
 * Off by default and switched by the user. Browsers only let audio start after a user gesture,
 * so `primeSuccessFeedback` is called from the toggle and from each action click; the beep that
 * follows the server's answer then plays on the already running context.
 */

type AudioContextConstructor = new () => AudioContext

let context: AudioContext | null = null

function audioContextConstructor(): AudioContextConstructor | undefined {
  const scope = globalThis as { AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor }
  return scope.AudioContext ?? scope.webkitAudioContext
}

/** Creates or resumes the audio context; call from a user gesture. */
export function primeSuccessFeedback(): void {
  const Constructor = audioContextConstructor()
  if (!Constructor) return
  try {
    context ??= new Constructor()
    if (context.state === 'suspended') void context.resume().catch(() => {})
  } catch {
    context = null
  }
}

const BEEP_HZ = 880
const BEEP_SECONDS = 0.12
const VIBRATION_MS = 60

/** A short, quiet sine beep plus a brief vibration. Never throws. */
export function playSuccessFeedback(): void {
  try {
    if (context && context.state === 'running') {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = BEEP_HZ
      const start = context.currentTime
      // A short fade in and out avoids the click of a hard start/stop.
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.2, start + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + BEEP_SECONDS)
      oscillator.connect(gain).connect(context.destination)
      oscillator.start(start)
      oscillator.stop(start + BEEP_SECONDS)
    }
  } catch {
    // Feedback is a nicety; a failing audio device must not affect the check-in.
  }
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(VIBRATION_MS)
  } catch {
    // As above.
  }
}

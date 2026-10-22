/*
 * The alert's sound (Phase 16): a short two-note tone made with the Web Audio API, so no sound file is
 * shipped or fetched. Browsers let a page play sound only after the person has interacted with it (their
 * autoplay policy): the audio context is created at the first press or key of the page, and until then a
 * new alert is shown and notified without a sound.
 */

type AudioContextConstructor = typeof AudioContext

let context: AudioContext | null = null

function audioContextConstructor(): AudioContextConstructor | null {
  // Older Safari names it webkitAudioContext.
  const scope = globalThis as typeof globalThis & { webkitAudioContext?: AudioContextConstructor }
  const candidate = typeof scope.AudioContext === 'function' ? scope.AudioContext : scope.webkitAudioContext
  return typeof candidate === 'function' ? candidate : null
}

/** Creates (or resumes) the audio context inside a person's gesture, where the browser allows it. */
function unlock(): void {
  const Constructor = audioContextConstructor()
  if (!Constructor) return
  try {
    context ??= new Constructor()
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
  } catch {
    context = null
  }
}

/** Listens for the page's first gestures, which allow its sound; returns the clean-up. */
export function installAudioUnlock(): () => void {
  const options = { capture: true, passive: true } as const
  window.addEventListener('pointerdown', unlock, options)
  window.addEventListener('keydown', unlock, options)
  return () => {
    window.removeEventListener('pointerdown', unlock, options)
    window.removeEventListener('keydown', unlock, options)
  }
}

/** A short beep, high then lower (about half a second), at a moderate level; nothing before the first gesture. */
export function beep(): void {
  if (!context || context.state === 'closed') return
  try {
    if (context.state === 'suspended') void context.resume().catch(() => undefined)
    const start = context.currentTime + 0.01
    for (const [index, frequency] of [880, 660].entries()) {
      const at = start + index * 0.22
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(frequency, at)
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2)
      oscillator.connect(gain).connect(context.destination)
      oscillator.start(at)
      oscillator.stop(at + 0.21)
    }
  } catch {
    // A sound is a courtesy: the toast says it.
  }
}

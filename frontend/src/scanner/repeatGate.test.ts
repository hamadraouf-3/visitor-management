import { describe, expect, it } from 'vitest'
import { createRepeatGate, detectionKey, REPEAT_WINDOW_MS } from './repeatGate'

const TOKEN = 'Xo3_vK9-aQ2rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2A'
const OTHER = 'Yp4_wL0-bR3sU8nO5cM9dZ2aX7fI6kQ1tE-hG_vJl3B'

describe('detectionKey', () => {
  it('is the token for a pass, whether read as a URL or as a bare token', () => {
    expect(detectionKey(`https://visitors.example.com/pass#${TOKEN}`)).toBe(TOKEN)
    expect(detectionKey(` ${TOKEN} `)).toBe(TOKEN)
  })

  it('is the trimmed text of anything else', () => {
    expect(detectionKey('  not a pass ')).toBe('not a pass')
  })
})

describe('createRepeatGate', () => {
  it('is 5 seconds by default (§10)', () => {
    expect(REPEAT_WINDOW_MS).toBe(5_000)
  })

  it('admits a new key and ignores the same key within the window', () => {
    const gate = createRepeatGate()
    expect(gate.admit(TOKEN, 0)).toBe(true)
    expect(gate.admit(TOKEN, 1_000)).toBe(false)
    expect(gate.admit(TOKEN, 4_999 + 1_000)).toBe(false)
  })

  it('keeps ignoring a code that stays in view, and admits it once it was away for the window', () => {
    const gate = createRepeatGate()
    expect(gate.admit(TOKEN, 0)).toBe(true)
    // Seen every 160 ms for 20 s: each sighting extends the window.
    for (let at = 160; at <= 20_000; at += 160) expect(gate.admit(TOKEN, at)).toBe(false)
    // Away for 5 s.
    expect(gate.admit(TOKEN, 20_000 + REPEAT_WINDOW_MS)).toBe(true)
  })

  it('admits another key at once, but not the first key again within its window (A, B, A)', () => {
    const gate = createRepeatGate()
    expect(gate.admit(TOKEN, 0)).toBe(true)
    expect(gate.admit(OTHER, 100)).toBe(true)
    // Visitor A, just checked in, still holds up their phone while B scans: A is not scanned again.
    expect(gate.admit(TOKEN, 200)).toBe(false)
    expect(gate.admit(OTHER, 300)).toBe(false)
    // Each code is handled again only once it has been away for the window.
    expect(gate.admit(TOKEN, 200 + REPEAT_WINDOW_MS)).toBe(true)
    expect(gate.admit(OTHER, 300 + REPEAT_WINDOW_MS - 1)).toBe(false)
    expect(gate.admit(OTHER, 300 + 2 * REPEAT_WINDOW_MS)).toBe(true)
  })

  it('keeps two alternating codes in view ignored for as long as they stay in view', () => {
    const gate = createRepeatGate()
    expect(gate.admit(TOKEN, 0)).toBe(true)
    expect(gate.admit(OTHER, 80)).toBe(true)
    for (let at = 160; at <= 20_000; at += 160) {
      expect(gate.admit(TOKEN, at)).toBe(false)
      expect(gate.admit(OTHER, at + 80)).toBe(false)
    }
  })

  it('restarts the window of the last key when scanning resumes', () => {
    const gate = createRepeatGate()
    gate.admit(TOKEN, 0)
    gate.refresh(10_000)
    expect(gate.admit(TOKEN, 14_000)).toBe(false)
    expect(gate.admit(TOKEN, 14_000 + REPEAT_WINDOW_MS)).toBe(true)
  })

  it('restarts the window of the last admitted key only', () => {
    const gate = createRepeatGate()
    gate.admit(TOKEN, 0)
    gate.admit(OTHER, 100)
    gate.refresh(4_000)
    expect(gate.admit(TOKEN, 5_000)).toBe(true)
    expect(gate.admit(OTHER, 8_000)).toBe(false)
  })

  it('forgets every key on reset', () => {
    const gate = createRepeatGate()
    gate.admit(TOKEN, 0)
    gate.admit(OTHER, 1)
    gate.reset()
    expect(gate.admit(TOKEN, 2)).toBe(true)
    expect(gate.admit(OTHER, 3)).toBe(true)
  })

  it('does nothing on refresh before any key was admitted', () => {
    const gate = createRepeatGate()
    gate.refresh(100)
    expect(gate.admit(TOKEN, 101)).toBe(true)
  })
})

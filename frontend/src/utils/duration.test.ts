import { describe, expect, it } from 'vitest'
import { formatAgo, formatDuration, formatDurationInText, formatIn, formatWaitDuration, secondsBetween } from './duration'

describe('formatDuration', () => {
  it.each([
    [5820, '1h 37m'],
    [3600, '1h'],
    [2700, '45m'],
    [60, '1m'],
    [119, '1m'],
    [59, '< 1m'],
    [0, '< 1m'],
    [-30, '< 1m'],
    [108_300, '30h 5m'],
    [5879.9, '1h 37m'],
  ])('formats %d seconds as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected)
  })

  it('shows a dash when the duration is unknown', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(undefined)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })
})

describe('secondsBetween', () => {
  it('returns whole non-negative seconds between instants', () => {
    expect(secondsBetween('2026-10-05T06:00:00Z', '2026-10-05T07:37:00Z')).toBe(5820)
    expect(secondsBetween('2026-10-05T07:00:00Z', '2026-10-05T06:00:00Z')).toBe(0)
    expect(secondsBetween(new Date('2026-10-05T06:00:00Z'), Date.parse('2026-10-05T06:00:01.900Z'))).toBe(1)
    expect(secondsBetween('nope', '2026-10-05T06:00:00Z')).toBe(0)
  })
})

describe('formatDuration in Arabic', () => {
  // Each number keeps its unit on its line (no-break spaces): «26» / «د» split across two lines in the
  // reception's headline (phase 10 review fixes); a line may break between the hours and the minutes.
  it.each([
    [5820, '1\u00a0س 37\u00a0د'],
    [3600, '1\u00a0س'],
    [2700, '45\u00a0د'],
    [59, '<\u00a01\u00a0د'],
  ])('formats %d seconds as %s', (seconds, expected) => {
    expect(formatDuration(seconds, 'ar')).toBe(expected)
  })

  it('shows a dash when the duration is unknown', () => {
    expect(formatDuration(null, 'ar')).toBe('—')
  })
})

describe('formatAgo and formatIn', () => {
  it('reads as English did: the duration with "ago" or "in"', () => {
    expect(formatAgo(5820, 'en')).toBe('1h 37m ago')
    expect(formatAgo(59, 'en')).toBe('< 1m ago')
    expect(formatIn(600, 'en')).toBe('in 10m')
    expect(formatIn(0, 'en')).toBe('in < 1m')
  })

  it('says under a minute in Arabic words, not «قبل < 1 د» (Arabic acceptance run)', () => {
    expect(formatAgo(5820, 'ar')).toBe('قبل 1\u00a0س 37\u00a0د')
    expect(formatAgo(59, 'ar')).toBe('قبل أقل من دقيقة')
    expect(formatAgo(-5, 'ar')).toBe('قبل أقل من دقيقة')
    expect(formatIn(600, 'ar')).toBe('بعد 10\u00a0د')
    expect(formatIn(30, 'ar')).toBe('بعد أقل من دقيقة')
    for (const text of [formatAgo(0, 'ar'), formatIn(0, 'ar')]) expect(text).not.toContain('<')
  })

  it('shows a dash when the time is unknown', () => {
    expect(formatAgo(Number.NaN, 'ar')).toBe('—')
    expect(formatIn(Number.NaN, 'en')).toBe('—')
  })

  it('keeps the short form in English and in figures, and words in Arabic sentences', () => {
    expect(formatDurationInText(59, 'en')).toBe('< 1m')
    expect(formatDurationInText(59, 'ar')).toBe('أقل من دقيقة')
    expect(formatDurationInText(2700, 'ar')).toBe('45\u00a0د')
    expect(formatDurationInText(null, 'ar')).toBe('—')
  })
})

/*
 * A wait in a sentence ("Try again in …", UX review L9 and the Arabic wording pass): whole words with
 * the Arabic plural of each unit, as after «بعد»; rounded up, since a wait must not be promised short.
 */
describe('formatWaitDuration', () => {
  it.each([
    [1500, '25\u00a0minutes'],
    [60, '1\u00a0minute'],
    [61, '2\u00a0minutes'],
    [1, '1\u00a0minute'],
    [0, '1\u00a0minute'],
    [3600, '1\u00a0hour'],
    [3540, '59\u00a0minutes'],
    [3541, '1\u00a0hour'],
    [3900, '1\u00a0hour 5\u00a0minutes'],
    [86_400, '24\u00a0hours'],
  ])('says %d seconds as %s', (seconds, expected) => {
    expect(formatWaitDuration(seconds, 'en')).toBe(expected)
  })

  it.each([
    [60, 'دقيقة واحدة'],
    [120, 'دقيقتين'],
    [300, '5\u00a0دقائق'],
    [660, '11\u00a0دقيقة'],
    [3540, '59\u00a0دقيقة'],
    [3600, 'ساعة واحدة'],
    [7200, 'ساعتين'],
    [10_800, '3\u00a0ساعات'],
    [3900, 'ساعة واحدة و5\u00a0دقائق'],
    [7320, 'ساعتين ودقيقتين'],
  ])('says %d seconds in Arabic as %s', (seconds, expected) => {
    expect(formatWaitDuration(seconds, 'ar')).toBe(expected)
  })

  it('never says zero or an unknown wait', () => {
    expect(formatWaitDuration(-5, 'en')).toBe('1\u00a0minute')
    expect(formatWaitDuration(Number.NaN, 'ar')).toBe('دقيقة واحدة')
  })
})

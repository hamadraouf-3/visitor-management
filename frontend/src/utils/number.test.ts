import { describe, expect, it } from 'vitest'
import { formatCount, formatNumber, formatPercent } from './number'

describe('formatCount', () => {
  it('groups thousands in the app locale', () => {
    expect(formatCount(1284)).toBe('1,284')
    expect(formatCount(0)).toBe('0')
    expect(formatCount(1_000_000)).toBe('1,000,000')
  })
})

describe('formatNumber and formatPercent', () => {
  it('use Latin digits in both languages', () => {
    expect(formatCount(1284, 'ar')).toBe('1,284')
    expect(formatPercent(0.125, 'en')).toBe('12.5%')
    expect(formatPercent(0.125, 'ar')).not.toMatch(/[٠-٩\u200E\u200F\u061C]/)
    expect(formatNumber(2.5, { maximumFractionDigits: 1 }, 'ar')).toBe('2.5')
  })
})

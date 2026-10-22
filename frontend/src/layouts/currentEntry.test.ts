import { BellRing, Route } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import type { NavEntry } from '../features/types'
import { currentEntry } from './currentEntry'

const entry = (to: string, end = false): NavEntry => ({ to, label: to, icon: to.includes('alerts') ? BellRing : Route, roles: ['RECEPTIONIST'], section: 'main', order: 1, end })

describe('the current navigation entry', () => {
  const journey = entry('/journey')
  const alerts = entry('/journey/alerts')
  const visits = entry('/visits', true)
  const entries = [journey, alerts, visits]

  it('is the most specific entry whose path matches: one current page only', () => {
    expect(currentEntry(entries, '/journey')).toBe(journey)
    expect(currentEntry(entries, '/journey/5a1b2c3d-0000-4000-8000-0000000000a1')).toBe(journey)
    expect(currentEntry(entries, '/journey/alerts')).toBe(alerts)
  })

  it('honours an exact entry (`end`), and finds none for another page', () => {
    expect(currentEntry(entries, '/visits')).toBe(visits)
    expect(currentEntry(entries, '/visits/new')).toBeNull()
    expect(currentEntry(entries, '/reports')).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { insideFlags } from './insideFlags'

const AMMAN = 'Asia/Amman'
// 12:00 in Amman on Tue 6 Oct 2026.
const NOW = '2026-10-06T09:00:00Z'

describe('insideFlags', () => {
  it('names no flag for a visitor inside on time', () => {
    expect(insideFlags({ is_overdue: false, is_stale: false, scheduled_end: '2026-10-06T10:00:00Z' }, AMMAN, NOW)).toEqual([])
  })

  it('names the time a visitor was due out today', () => {
    const flags = insideFlags({ is_overdue: true, is_stale: false, scheduled_end: '2026-10-06T07:00:00Z' }, AMMAN, NOW)
    expect(flags.map((flag) => flag.label)).toEqual(['Overdue · due out 10:00'])
  })

  it('puts "Previous day" first and leaves an earlier day’s time out of the overdue flag', () => {
    const flags = insideFlags({ is_overdue: true, is_stale: true, scheduled_end: '2026-10-05T15:00:00Z' }, AMMAN, NOW)
    expect(flags.map((flag) => flag.label)).toEqual(['Previous day', 'Overdue'])
  })

  it('judges "today" in the company time zone, not the browser’s', () => {
    // 23:30 UTC on 5 Oct is 02:30 on 6 Oct in Amman: due out today there.
    const flags = insideFlags({ is_overdue: true, is_stale: true, scheduled_end: '2026-10-05T23:30:00Z' }, AMMAN, NOW)
    expect(flags.map((flag) => flag.label)).toEqual(['Previous day', 'Overdue · due out 02:30'])
  })
})

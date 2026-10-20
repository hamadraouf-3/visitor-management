import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadTextFile } from './download'

describe('downloadTextFile', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('follows a typed Blob’s address through a link with `download`, at once, in this tab, and lets the address go 40 s later', async () => {
    vi.useFakeTimers()
    const blobs: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob)
      return 'blob:calendar/1'
    })
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clicked: { href: string; download: string; target: string; connected: boolean }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download, target: this.target, connected: this.isConnected })
    })

    downloadTextFile('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', 'visit-2026-10-06.ics', 'text/calendar;charset=utf-8')

    // Within the caller's click: iOS keeps the person's tap, and opens a `text/calendar` Blob as "Add to Calendar".
    expect(clicked).toEqual([{ href: 'blob:calendar/1', download: 'visit-2026-10-06.ics', target: '', connected: true }])
    expect(blobs[0]!.type).toBe('text/calendar;charset=utf-8')
    expect(await blobs[0]!.text()).toBe('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')
    expect(document.querySelector('a[download]')).toBeNull()
    vi.advanceTimersByTime(39_999)
    expect(revoke).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(revoke).toHaveBeenCalledWith('blob:calendar/1')
  })
})

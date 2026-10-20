import { readFileSync } from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import type { EmailTemplate, PlatformCompany, Visit } from '../../src/types/api.ts'
import { ACCOUNTS } from '../support/accounts.ts'
import { Api, passToken } from '../support/api.ts'
import { expect, test } from '../support/fixtures.ts'
import { lineProblems, parseCalendar, type ParsedEvent } from '../support/icalendar.ts'
import { calendarBytes, calendarFile, findMessages, inlineImages, waitForMessage, type OutboxCalendar, type OutboxMessage } from '../support/outbox.ts'
import { localDate, minutes, wallTimeToInstant } from '../support/time.ts'
import { uniqueTag } from '../support/ui.ts'

/*
 * A visit in the visitor's and the host's calendars (Phase 14), with the real API and the outbox:
 *
 * - creating a visit with an invitation sends the visitor the invitation (no event: a calendar copies
 *   an invitation's body, pass link and QR code included) and a short calendar e-mail carrying the
 *   visitor's event, and the host a new-visit e-mail carrying the host's event; a new time and a
 *   cancellation update both, with the same UIDs and a SEQUENCE that goes up (REQUEST, REQUEST, CANCEL);
 *   the visitor who has the visit in their calendar is sent the cancellation even when the host asks
 *   for no notice (the owner's decision);
 * - a visitor's new address: the old address's calendar is sent the withdrawal (a CANCEL, one version
 *   newer), the new one the invitation one version newer still; a removed address only the withdrawal;
 * - every event, read by a real iCalendar parser (the backend's `icalendar`), says what its message's
 *   JSON says, and holds no pass link or token;
 * - the visit page's "Add to my calendar" offers the host's own event: Google Calendar's and Outlook's
 *   links, and an `.ics` that is the e-mailed event (same UID, SEQUENCE, times and words), without the
 *   pass and without the invitation's ORGANIZER and ATTENDEE; written from the visit as it is when the
 *   menu opens, so a page left open over a new time offers the new one, and over a cancellation nothing;
 * - the host's three e-mails are in the company administrator's and the platform owner's e-mail texts,
 *   with their preview and their test, which carries no event.
 */

const MENU = 'Add to my calendar'
const FILE_ITEM = 'Apple and others (.ics)'

/** An instant in UTC to the second, as the parser writes it (`2026-10-21T07:00:00Z`). */
const utc = (instant: Date) => instant.toISOString().replace(/\.\d{3}Z$/, 'Z')
/** A description as the calendars' links carry it: HTML, its `&`, `<`, `>` and `"` escaped, each line a `<br>`. */
const asHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>')
/** The same instant as an iCalendar DATE-TIME (`20261021T070000Z`), as Google's link carries it. */
const compact = (instant: Date) => utc(instant).replace(/[-:]/g, '')

/** The event a message carries, read by the parser: its METHOD, UID and SEQUENCE are the message's `calendar`; no pass in it. */
async function eventOf(message: OutboxMessage, expected: OutboxCalendar, token: string): Promise<ParsedEvent> {
  expect(message.calendar, `${message.kind}: its calendar`).toEqual(expected)
  const bytes = calendarBytes(message)
  if (bytes === null) throw new Error(`${message.kind} to ${message.to} carries no .ics`)
  expect(lineProblems(bytes), `${message.kind}: lines`).toEqual([])
  const ics = bytes.toString('utf8')
  expect(ics).not.toContain(token)
  expect(ics).not.toContain('/pass')
  const events = await parseCalendar(ics)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ method: expected.method, uid: expected.uid, sequence: expected.sequence })
  return events[0]!
}

/** Each message's kind, method and SEQUENCE: `HOST_VISIT_CANCELLED CANCEL 2`. */
function sequences(messages: OutboxMessage[]): string[] {
  return messages.map((message) => `${message.kind} ${message.calendar?.method} ${message.calendar?.sequence}`)
}

/** Opens the visit page's calendar menu. */
async function openCalendarMenu(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: MENU }).click()
  const menu = page.getByRole('menu', { name: MENU })
  await expect(menu).toBeVisible()
  return menu
}

/** The `.ics` the menu saves: its file name, its octets and its text. */
async function downloadFile(page: Page, menu: Locator): Promise<{ name: string; bytes: Buffer; text: string }> {
  const [download] = await Promise.all([page.waitForEvent('download'), menu.getByRole('menuitem', { name: FILE_ITEM }).click()])
  const bytes = readFileSync(await download.path())
  return { name: download.suggestedFilename(), bytes, text: bytes.toString('utf8') }
}

/** The visit page's schedule ("When"). */
const scheduleOf = (page: Page) => page.locator('dl').filter({ has: page.getByText('When', { exact: true }) }).first()

test('a visit in the visitor’s and the host’s calendars: created, moved, cancelled, and offered on the visit page', async ({ open, apiAs }) => {
  const tag = uniqueTag()
  const host = await apiAs('employee')
  const timeZone = (await host.me()).company.timezone
  const day = localDate(Date.now() + minutes(2 * 24 * 60), timeZone)
  const start = wallTimeToInstant(day, '10:00', timeZone)
  const end = new Date(start.getTime() + minutes(60))
  const visitorName = `Calendar Guest ${tag}`
  const visitorEmail = `calendar.${tag}@guest.test`
  const created = await host.createVisit({
    visitor: { full_name: visitorName, email: visitorEmail, company_name: 'Cedar Advisory' },
    start,
    end,
    purpose: `Quarterly review; budget, plans ${tag}`,
    sendInvitation: true,
  })
  const id = created.visit.id
  const token = passToken(created.pass_url)
  const visitorUid = `visit-${id}-visitor`
  const hostUid = `visit-${id}-host`
  const toHost = (kind: OutboxMessage['kind']) => waitForMessage({ kind, to: ACCOUNTS.employee.email, where: (message) => message.calendar?.uid === hostUid })
  expect(created.visit.calendar_sequence).toBe(0)

  // Created: the invitation carries no event; the visitor's calendar e-mail and the host's new-visit e-mail do.
  const invitation = await waitForMessage({ kind: 'VISITOR_INVITATION', to: visitorEmail })
  expect(invitation.calendar).toBeNull()
  expect(calendarFile(invitation)).toBeNull()
  const visitorCalendar = await waitForMessage({ kind: 'VISITOR_CALENDAR', to: visitorEmail, where: (message) => message.calendar?.method === 'REQUEST' })
  const visitorEvent = await eventOf(visitorCalendar, { method: 'REQUEST', uid: visitorUid, sequence: 0 }, token)
  expect(visitorEvent).toMatchObject({ start: utc(start), end: utc(end), summary: 'Visit to Mawdoo3', status: 'CONFIRMED', rsvp: 'FALSE', classification: null })
  // No link and no QR code in the visitor's calendar e-mail: it is copied into calendars.
  expect(visitorCalendar.pass_url).toBeNull()
  expect(`${visitorCalendar.html}${visitorCalendar.text}`).not.toContain(token)
  expect(inlineImages(visitorCalendar)).toEqual([])
  const hostScheduled = await toHost('HOST_VISIT_SCHEDULED')
  expect(hostScheduled.subject).toContain(visitorName)
  const hostEvent = await eventOf(hostScheduled, { method: 'REQUEST', uid: hostUid, sequence: 0 }, token)
  expect(hostEvent).toMatchObject({
    start: utc(start),
    end: utc(end),
    summary: `Visit: ${visitorName}`,
    status: 'CONFIRMED',
    attendee: `mailto:${ACCOUNTS.employee.email}`,
    rsvp: 'FALSE',
    // Private (B14-19); the visit page's file says so too (compared below).
    classification: 'PRIVATE',
  })
  expect(hostEvent.description).toContain(`Purpose: Quarterly review; budget, plans ${tag}`)
  expect(`${hostScheduled.html}${hostScheduled.text}`).not.toContain(token)

  // The visit page: the host's own event, as the e-mail carries it.
  const { page } = await open({ as: 'employee' })
  await page.goto(`/visits/${id}`)
  await expect(page.getByRole('heading', { level: 1, name: visitorName })).toBeVisible()
  let menu = await openCalendarMenu(page)
  await expect(menu.getByRole('menuitem')).toHaveText(['Google Calendar', 'Outlook', FILE_ITEM])
  const google = new URL((await menu.getByRole('menuitem', { name: 'Google Calendar (opens in a new tab)' }).getAttribute('href'))!)
  expect(google.origin + google.pathname).toBe('https://calendar.google.com/calendar/render')
  expect(Object.fromEntries(google.searchParams)).toEqual({
    action: 'TEMPLATE',
    text: hostEvent.summary,
    dates: `${compact(start)}/${compact(end)}`,
    details: asHtml(hostEvent.description!),
    location: hostEvent.location,
  })
  const outlook = new URL((await menu.getByRole('menuitem', { name: 'Outlook (opens in a new tab)' }).getAttribute('href'))!)
  expect(outlook.origin + outlook.pathname).toBe('https://outlook.office.com/calendar/0/deeplink/compose')
  expect(Object.fromEntries(outlook.searchParams)).toEqual({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: hostEvent.summary,
    startdt: utc(start),
    enddt: utc(end),
    body: asHtml(hostEvent.description!),
    location: hostEvent.location,
  })
  for (const link of [google, outlook]) expect(link.href).not.toContain(token)
  const first = await downloadFile(page, menu)
  expect(first.name).toBe(`visit-${day}.ics`)
  expect(lineProblems(first.bytes)).toEqual([])
  expect(first.text).not.toContain(token)
  const [own] = await parseCalendar(first.text)
  // The e-mailed event, as the host's own copy: no METHOD, ORGANIZER or ATTENDEE.
  expect(own).toEqual({ ...hostEvent, method: null, organizer: null, attendee: null, rsvp: null })

  // Moved, while the page is open: the same UIDs, SEQUENCE 1, the new time. The page polls nothing once
  // the invitation is sent, so it shows the old time until something fetches the visit again.
  await expect(page.locator('main header').getByText('Invitation sent').first()).toBeVisible()
  const newStart = wallTimeToInstant(day, '14:30', timeZone)
  const newEnd = new Date(newStart.getTime() + minutes(45))
  const moved = await host.ok<Visit>('PATCH', `/visits/${id}`, { scheduled_start: newStart.toISOString(), scheduled_end: newEnd.toISOString() })
  expect(moved.calendar_sequence).toBe(1)
  const rescheduled = await waitForMessage({ kind: 'VISIT_RESCHEDULED', to: visitorEmail })
  expect(await eventOf(rescheduled, { method: 'REQUEST', uid: visitorUid, sequence: 1 }, token)).toMatchObject({ start: utc(newStart), end: utc(newEnd) })
  const hostRescheduled = await toHost('HOST_VISIT_RESCHEDULED')
  const movedEvent = await eventOf(hostRescheduled, { method: 'REQUEST', uid: hostUid, sequence: 1 }, token)
  expect(movedEvent).toMatchObject({ start: utc(newStart), end: utc(newEnd) })
  // The menu is written from the visit as it is when it opens, not as the page last fetched it.
  await expect(scheduleOf(page)).toContainText('10:00')
  menu = await openCalendarMenu(page)
  const googleMoved = new URL((await menu.getByRole('menuitem', { name: 'Google Calendar (opens in a new tab)' }).getAttribute('href'))!)
  expect(googleMoved.searchParams.get('dates')).toBe(`${compact(newStart)}/${compact(newEnd)}`)
  const outlookMoved = new URL((await menu.getByRole('menuitem', { name: 'Outlook (opens in a new tab)' }).getAttribute('href'))!)
  expect([outlookMoved.searchParams.get('startdt'), outlookMoved.searchParams.get('enddt')]).toEqual([utc(newStart), utc(newEnd)])
  const [ownMoved] = await parseCalendar((await downloadFile(page, menu)).text)
  expect(ownMoved).toEqual({ ...movedEvent, method: null, organizer: null, attendee: null, rsvp: null })
  // And the page shows that visit too.
  await expect(scheduleOf(page)).toContainText('14:30')

  // Settled, as a page opened now: the e-mails of the new time sent, nothing polled.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: visitorName })).toBeVisible()
  await expect(scheduleOf(page)).toContainText('14:30')

  // Cancelled: CANCEL, SEQUENCE 2, and nothing to add any more. Asked not to notify the visitor, but the
  // visitor has the visit in their calendar: the cancellation goes to them anyway, and takes it out.
  expect((await host.visit(id)).visitor_calendar_sent).toBe(true)
  const cancelled = await host.ok<Visit>('POST', `/visits/${id}/cancel`, { reason: `Calendar check ${tag}`, notify_visitor: false })
  expect(cancelled.calendar_sequence).toBe(2)
  const cancelNotice = await waitForMessage({ kind: 'VISIT_CANCELLED', to: visitorEmail })
  expect((await eventOf(cancelNotice, { method: 'CANCEL', uid: visitorUid, sequence: 2 }, token)).status).toBe('CANCELLED')
  const hostCancelled = await toHost('HOST_VISIT_CANCELLED')
  expect((await eventOf(hostCancelled, { method: 'CANCEL', uid: hostUid, sequence: 2 }, token)).status).toBe('CANCELLED')
  // The page, open over the cancellation, still offers the menu: it opens nothing, the page shows the
  // cancellation, and the focus goes on from its heading.
  await expect(page.getByText('This visit was cancelled')).toHaveCount(0)
  const trigger = page.getByRole('button', { name: MENU })
  await trigger.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('This visit was cancelled')).toBeVisible()
  await expect(trigger).toHaveCount(0)
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1, name: visitorName })).toBeFocused()

  // One calendar e-mail of each kind for this visit, their SEQUENCE going up.
  expect(sequences(findMessages({ kind: 'VISITOR_CALENDAR', to: visitorEmail }))).toEqual(['VISITOR_CALENDAR REQUEST 0'])
  expect(sequences([hostScheduled, hostRescheduled, hostCancelled])).toEqual(['HOST_VISIT_SCHEDULED REQUEST 0', 'HOST_VISIT_RESCHEDULED REQUEST 1', 'HOST_VISIT_CANCELLED CANCEL 2'])
})

test('a visitor’s new address: the old address’s calendar loses the visit, the new one is invited a version newer; a removed address only loses it', async ({ apiAs }) => {
  const tag = uniqueTag()
  const host = await apiAs('employee')
  const start = new Date(Date.now() + minutes(4 * 24 * 60))
  const oldEmail = `moving.${tag}@guest.test`
  const newEmail = `moved.${tag}@guest.test`
  const created = await host.createVisit({ visitor: { full_name: `Moving Guest ${tag}`, email: oldEmail }, start, end: new Date(start.getTime() + minutes(30)), sendInvitation: true })
  const id = created.visit.id
  const uid = `visit-${id}-visitor`
  const sent = await waitForMessage({ kind: 'VISITOR_CALENDAR', to: oldEmail })
  expect(sent.calendar).toEqual({ method: 'REQUEST', uid, sequence: 0 })
  await host.settledInvitation(id)

  await host.ok('PATCH', `/visitors/${created.visit.visitor.id}`, { email: newEmail })
  const withdrawal = await waitForMessage({ kind: 'VISITOR_CALENDAR', to: oldEmail, where: (message) => message.calendar?.method === 'CANCEL' })
  // The withdrawal is the version after the one the old calendar holds (N + 1), the new address's invitation the next (N + 2).
  await eventOf(withdrawal, { method: 'CANCEL', uid, sequence: 1 }, passToken(created.pass_url))
  // The withdrawal says nothing of the visit: no pass, no name.
  expect(withdrawal.pass_url).toBeNull()
  expect(`${withdrawal.html}${withdrawal.text}`).not.toContain(`Moving Guest ${tag}`)
  const invitation = await waitForMessage({ kind: 'VISITOR_INVITATION', to: newEmail })
  const invited = await waitForMessage({ kind: 'VISITOR_CALENDAR', to: newEmail })
  await eventOf(invited, { method: 'REQUEST', uid, sequence: 2 }, passToken(created.pass_url))
  expect(withdrawal.created_at <= invitation.created_at).toBe(true)
  expect(await host.settledInvitation(id)).toMatchObject({ calendar_sequence: 2, visitor_calendar_sent: true, invitation: { status: 'SENT', to_email: newEmail } })

  await host.ok('PATCH', `/visitors/${created.visit.visitor.id}`, { email: null })
  const removed = await waitForMessage({ kind: 'VISITOR_CALENDAR', to: newEmail, where: (message) => message.calendar?.method === 'CANCEL' })
  expect(removed.calendar).toEqual({ method: 'CANCEL', uid, sequence: 3 })
  expect(findMessages({ kind: 'VISITOR_INVITATION', to: newEmail })).toHaveLength(1)
  expect(await host.visit(id)).toMatchObject({ calendar_sequence: 3, visitor_calendar_sent: false })
})

test('a pass the host shares puts nothing in the visitor’s calendar; the host’s still gets the visit', async ({ apiAs }) => {
  const tag = uniqueTag()
  const host = await apiAs('employee')
  const start = new Date(Date.now() + minutes(3 * 24 * 60))
  const visitorEmail = `shared.${tag}@guest.test`
  const created = await host.createVisit({ visitor: { full_name: `Shared Guest ${tag}`, email: visitorEmail }, start, end: new Date(start.getTime() + minutes(30)), sendInvitation: false })
  const hostUid = `visit-${created.visit.id}-host`
  const hostScheduled = await waitForMessage({ kind: 'HOST_VISIT_SCHEDULED', to: ACCOUNTS.employee.email, where: (message) => message.calendar?.uid === hostUid })
  expect(hostScheduled.calendar).toEqual({ method: 'REQUEST', uid: hostUid, sequence: 0 })
  expect(calendarFile(hostScheduled)).not.toContain(passToken(created.pass_url))
  // The host's e-mail was written after the visitor's would have been: none was.
  for (const kind of ['VISITOR_INVITATION', 'VISITOR_CALENDAR'] as const) expect(findMessages({ kind, to: visitorEmail })).toEqual([])
})

test('the host’s visit e-mails in the e-mail texts: listed, edited, previewed and tested, by the administrator and the platform owner', async ({ open, apiAs }) => {
  const tag = uniqueTag()
  const api = await apiAs('otherAdmin')
  const { page } = await open({ as: 'otherAdmin' })
  const kinds = [
    ['HOST_VISIT_SCHEDULED', 'New visit (host)'],
    ['HOST_VISIT_RESCHEDULED', 'Visit rescheduled (host)'],
    ['HOST_VISIT_CANCELLED', 'Visit cancelled (host)'],
  ] as const
  try {
    await page.goto('/admin/email-templates')
    const list = page.getByRole('list', { name: 'Emails' })
    await expect(list.getByRole('listitem')).toHaveCount(7)
    for (const [kind, name] of kinds) {
      const row = list.getByRole('listitem').filter({ has: page.getByRole('link', { name, exact: true }) })
      await expect(row).toContainText('To the host')
      await expect(row.getByRole('link')).toHaveAttribute('href', `/admin/email-templates/${kind}`)
    }

    for (const [kind, name] of kinds) {
      const template = await api.ok<EmailTemplate>('GET', `/email-templates/${kind}`)
      expect(template.fields.map((item) => item.name)).toEqual(['subject', 'heading', 'greeting', 'intro', 'closing', 'footer_note'])
      await page.goto(`/admin/email-templates/${kind}`)
      await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
      const subject = page.locator('[data-template-field="en.subject"]')
      await expect(subject.getByRole('textbox')).toHaveAttribute('placeholder', template.fields[0]!.default.en)
      await expect(page.locator('[data-template-field="en.button"]')).toHaveCount(0)
      // The subject names the visitor and never holds the purpose.
      await subject.getByRole('textbox').fill(`Visit ${tag}`)
      await expect(subject).toContainText('Include “Visitor name” in this text.')
      await subject.getByRole('textbox').fill(`Visit {visitor_name} {purpose} ${tag}`)
      await expect(subject).toContainText('“Purpose” cannot be used in this text.')
      await subject.getByRole('textbox').fill(`Visit {visitor_name} ${tag}`)
      await expect(page.locator('[data-preview-subject]')).toContainText(`Visit `, { timeout: 15_000 })
      await expect(page.locator('[data-preview-subject]')).toContainText(tag)
      // The saved e-mail, light and dark.
      await page.getByRole('tab', { name: 'Saved email' }).click()
      const frame = page.locator('[data-saved-preview]')
      await expect(frame).toHaveAttribute('src', new RegExp(`/api/v1/email-templates/${kind}/preview\\?language=en&scheme=light$`))
      await expect(page.frameLocator('[data-saved-preview]').locator('body')).not.toBeEmpty({ timeout: 15_000 })
      await page.getByRole('radiogroup', { name: 'Email appearance' }).getByText('Dark', { exact: true }).click()
      await expect(frame).toHaveAttribute('src', new RegExp(`/api/v1/email-templates/${kind}/preview\\?language=en&scheme=dark$`))
      // A test of the draft to the administrator: never with an event.
      await page.getByRole('button', { name: 'Send test' }).click()
      await expect(page.getByText('Test email sent')).toBeVisible()
      const sent = await waitForMessage({ kind, to: ACCOUNTS.otherAdmin.email, where: (message) => message.subject.includes(tag) })
      expect(sent.subject.startsWith(`[Test] Visit `)).toBe(true)
      expect(sent.calendar).toBeNull()
      expect(calendarFile(sent)).toBeNull()
      // Leave without saving the draft.
      await page.getByRole('tab', { name: 'Draft' }).click()
      await subject.getByRole('textbox').fill('')
    }
  } finally {
    for (const [kind] of kinds) await api.ok('POST', `/email-templates/${kind}/reset`, {})
  }

  // The platform owner's editor of Other Corp's texts lists and opens them too.
  const platform = await Api.platform()
  try {
    const companies = await platform.ok<{ items: PlatformCompany[] }>('GET', '/platform/companies?q=other-corp')
    const otherCorp = companies.items.find((company) => company.slug === 'other-corp')!
    const owner = await open({ platform: true })
    await owner.page.goto(`/platform/companies/${otherCorp.id}/email-templates`)
    const list = owner.page.getByRole('list', { name: 'Emails' })
    await expect(list.getByRole('listitem')).toHaveCount(7)
    await list.getByRole('link', { name: 'Visit rescheduled (host)', exact: true }).click()
    await expect(owner.page.getByRole('heading', { level: 1, name: 'Visit rescheduled (host)' })).toBeVisible()
    await expect(owner.page.locator('[data-preview-subject]')).not.toBeEmpty({ timeout: 15_000 })
  } finally {
    await platform.dispose()
  }
})

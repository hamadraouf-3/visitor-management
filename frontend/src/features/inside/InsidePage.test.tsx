import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '../../i18n'
import { routes } from '../../test/appRoutes'
import { errorResponse, jsonResponse, makeMe, mockApi, type RecordedRequest, type RouteHandler } from '../../test/api'
import { LEGAL, makeInsideVisit, makeVisit } from '../../test/fixtures'
import { makeBrand } from '../../test/palettes'
import { renderRoutes } from '../../test/render'
import type { InsideList, Role, Visit } from '../../types/api'
import { asciiDigits } from '../../utils/phone'

const NOW = new Date('2026-10-05T06:31:05Z') // 09:31:05 in Amman

const overdue = makeVisit({
  id: '5a1b2c3d-0000-4000-8000-000000000021',
  status: 'CHECKED_IN',
  visitor: { id: 'v-21', full_name: 'Zara Haddad', company_name: 'Northwind' },
  host: { id: 'h-1', full_name: 'Omar Khalil', phone: '+962 79 000 0077' },
  department: { id: LEGAL.id, name: LEGAL.name, name_ar: null },
  // 08:00–09:00 in Amman, checked in at 08:02: overdue at 09:31.
  scheduled_start: '2026-10-05T05:00:00Z',
  scheduled_end: '2026-10-05T06:00:00Z',
  check_in_at: '2026-10-05T05:02:00Z',
  check_in_method: 'QR',
  checked_in_by: { id: 'r-1', full_name: 'Rana Reception' },
  is_overdue: true,
})

const stale = makeVisit({
  id: '5a1b2c3d-0000-4000-8000-000000000022',
  status: 'CHECKED_IN',
  visitor: { id: 'v-22', full_name: 'Adam Noor', company_name: null },
  host: { id: 'h-2', full_name: 'Lina Haddad', phone: null },
  department: null,
  // Sat 3 Oct, 17:30–18:30 in Amman, and never checked out.
  scheduled_start: '2026-10-03T14:30:00Z',
  scheduled_end: '2026-10-03T15:30:00Z',
  check_in_at: '2026-10-03T14:40:00Z',
  check_in_method: 'MANUAL',
  checked_in_by: { id: 'r-1', full_name: 'Rana Reception' },
  is_stale: true,
  is_overdue: true,
})

function inside(visits: Visit[]): InsideList {
  return { count: visits.length, items: visits.map((visit) => makeInsideVisit(visit, visit.id === stale.id ? '+962 79 555 0199' : null)) }
}

function insideRequests(requests: RecordedRequest[]) {
  return requests.filter((request) => request.path === '/reception/inside')
}

function printView(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-print-evacuation-list]')
  if (!element) throw new Error('No printable evacuation list')
  return element
}

function setup(handler: RouteHandler = () => jsonResponse(inside([overdue, stale])), roles: Role[] = ['RECEPTIONIST']) {
  const api = mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(roles)), 'GET /reception/inside': handler })
  return { ...api, ...renderRoutes(routes, { initialEntries: ['/inside'] }) }
}

afterEach(async () => {
  vi.useRealTimers()
  await i18n.changeLanguage('en')
})

describe('Inside now (evacuation list)', () => {
  it('shows the headcount, flags and everyone inside in roll-call order', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    setup()

    const table = await screen.findByRole('table', { name: 'Visitors inside now' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((row) => within(row).getAllByRole('link')[0]?.textContent)).toEqual(['Adam Noor', 'Zara Haddad'])
    expect(within(rows[1]!).getByRole('link', { name: 'Call Omar Khalil: +962 79 000 0077' })).toHaveAttribute('href', 'tel:+962790000077')
    expect(within(rows[1]!).getByText('Overdue · due out 09:00')).toBeInTheDocument()
    expect(rows[1]).toHaveTextContent('08:02')
    // The same words and tone as the reception Inside tab.
    expect(within(rows[0]!).getByText('Previous day')).toBeInTheDocument()
    expect(within(rows[0]!).getByText('Overdue')).toBeInTheDocument()
    expect(rows[0]).toHaveTextContent('Sat, 3 Oct 2026, 17:40')
    // The visitor's own current number (B57-72), to call someone missing at the assembly point.
    const adamPhone = within(rows[0]!).getByRole('link', { name: 'Call Adam Noor: +962 79 555 0199' })
    expect(adamPhone).toHaveAttribute('href', 'tel:+962795550199')
    // Without a company line between them, the phone still gets a line of its own under the name.
    const phoneLine = adamPhone.closest('[data-visitor-phone]') as HTMLElement
    expect(phoneLine.tagName).toBe('DIV')
    expect(phoneLine.previousElementSibling).toHaveTextContent('Adam Noor')
    // On a touch screen the phone's touch area reaches 12 px up: in the cards and in the table
    // alike, the name keeps those 12 px clear under it and at least 44 px above them, also without
    // a company line (in a card it took the name's lower 8 px, and a tap there dialled).
    expect(phoneLine.previousElementSibling).toHaveClass('pointer-coarse:min-h-11', 'pointer-coarse:mb-3')
    expect(phoneLine.previousElementSibling?.className).not.toMatch(/(?:^|\s)(?:max-)?(?:sm|md|lg|xl):/)
    // Without a phone under it, the name keeps its plain lines (no room kept for a touch target).
    expect(within(rows[1]!).getByRole('link', { name: 'Zara Haddad' }).parentElement).not.toHaveClass('pointer-coarse:mb-3')
    expect(within(rows[1]!).queryByRole('link', { name: /^Call Zara Haddad/ })).toBeNull()

    expect(screen.getByText('Headcount').closest('div')).toHaveTextContent('2')
    // The tiles' labels (the table's flags say the same words).
    expect(screen.getByText('Overdue', { selector: 'p > span' }).closest('div')).toHaveTextContent('2')
    expect(screen.getByText('Previous day', { selector: 'p > span' }).closest('div')).toHaveTextContent('1')
    // The list's time under the title, live; no time-zone or refresh sentence (decision 3).
    expect(screen.getByText('Updated 09:31:05')).toBeInTheDocument()
    const header = screen.getByRole('heading', { level: 1, name: 'Inside now' }).closest('header') as HTMLElement
    expect(header).not.toHaveTextContent(/Amman time|Refreshes every/)
    expect(screen.getByText('Headcount').closest('div.rounded-card')).toHaveClass('bg-emphasis')
  })

  it('leaves the flags out of the card of a visitor without any, keeping "None" in the table', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const onTime = makeVisit({
      ...overdue,
      id: '5a1b2c3d-0000-4000-8000-000000000023',
      visitor: { id: 'v-23', full_name: 'Mei Chen', company_name: 'Orbit Labs' },
      scheduled_end: '2026-10-05T08:00:00Z',
      is_overdue: false,
    })
    setup(() => jsonResponse(inside([onTime, overdue])))
    const table = await screen.findByRole('table', { name: 'Visitors inside now' })
    const mei = within(table).getByRole('link', { name: 'Mei Chen' }).closest('tr') as HTMLElement
    const flags = within(mei).getByText('None').closest('td') as HTMLElement
    expect(flags.className).toContain('max-lg:hidden')
    const zara = within(table).getByRole('link', { name: 'Zara Haddad' }).closest('tr') as HTMLElement
    expect(within(zara).getByText('Overdue · due out 09:00').closest('td')?.className).not.toContain('max-lg:hidden')
  })

  it('prints a black-on-white list with the company, the time it was generated and the headcount', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    setup()
    await screen.findByRole('table', { name: 'Visitors inside now' })

    const print = printView()
    // Only on paper, and not read twice by assistive technology.
    expect(print).toHaveClass('hidden', 'print:block')
    expect(print).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('heading', { level: 1, name: 'Inside now' }).closest('.print\\:hidden')).not.toBeNull()

    expect(print).toHaveTextContent('Acme Holdings')
    expect(print).toHaveTextContent('Evacuation list: visitors on site')
    expect(print).toHaveTextContent('Generated Mon, 5 Oct 2026 at 09:31:05, Amman time (UTC+3)')
    expect(print).toHaveTextContent('Headcount: 2')
    expect(print).toHaveTextContent('Printed by Lina Haddad')

    const rows = Array.from(print.querySelectorAll('tbody tr'))
    expect(rows.map((row) => Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent))).toEqual([
      ['1', 'Adam Noor', '+962 79 555 0199', '', 'Lina Haddad', '', '', 'Sat, 3 Oct 2026, 17:40', 'Previous day, Overdue', 'Tick when accounted for'],
      ['2', 'Zara Haddad', '', 'Northwind', 'Omar Khalil', '+962 79 000 0077', 'Legal', '08:02', 'Overdue · due out 09:00', 'Tick when accounted for'],
    ])
    // Nothing interactive on paper.
    expect(print.querySelector('a, button, input')).toBeNull()
  })

  it('names the company by its Arabic name on paper when the UI is Arabic (phase 10 contract)', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const me = makeMe(['RECEPTIONIST'])
    const arabicMe = {
      ...me,
      user: { ...me.user, preferred_language: 'ar' as const },
      company: { ...me.company, name: 'Mawdoo3', name_ar: 'موضوع' },
    }
    mockApi({ 'GET /auth/me': () => jsonResponse(arabicMe), 'GET /reception/inside': () => jsonResponse(inside([overdue])) })
    renderRoutes(routes, { initialEntries: ['/inside'] })

    await waitFor(() => expect(document.documentElement).toHaveAttribute('lang', 'ar'))
    await waitFor(() => expect(printView()).toHaveTextContent('موضوع'))
    expect(printView()).not.toHaveTextContent('Mawdoo3')
  })

  it('names each department in the UI language, on screen and on paper (phase 10 shared contract B)', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const legal = makeVisit({ ...overdue, department: { id: LEGAL.id, name: 'Legal', name_ar: 'الشؤون القانونية' } })
    const me = makeMe(['RECEPTIONIST'])
    const arabicMe = { ...me, user: { ...me.user, preferred_language: 'ar' as const } }
    mockApi({ 'GET /auth/me': () => jsonResponse(arabicMe), 'GET /reception/inside': () => jsonResponse(inside([legal, stale])) })
    renderRoutes(routes, { initialEntries: ['/inside'] })

    await screen.findByRole('heading', { level: 1, name: 'داخل المبنى الآن' })
    const main = screen.getByRole('main')
    await waitFor(() => expect(within(main).getAllByText('الشؤون القانونية').length).toBeGreaterThan(0))
    expect(printView()).toHaveTextContent('الشؤون القانونية')
    expect(main).not.toHaveTextContent('Legal')

    // English: the department's English name, on screen and on paper.
    await act(() => i18n.changeLanguage('en'))
    await waitFor(() => expect(within(main).getAllByText('Legal').length).toBeGreaterThan(0))
    expect(main).not.toHaveTextContent('الشؤون القانونية')
  })

  it('prints the whole roll-call sheet in Arabic, with no physical-side offset that would push columns off the page', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    const me = makeMe(['RECEPTIONIST'])
    const brand = makeBrand(me.company.slug, { logo: true })
    const arabicMe = { ...me, user: { ...me.user, preferred_language: 'ar' as const }, company: { ...me.company, name: 'Mawdoo3', name_ar: 'موضوع', brand } }
    mockApi({ 'GET /auth/me': () => jsonResponse(arabicMe), 'GET /reception/inside': () => jsonResponse(inside([overdue, stale])) })
    renderRoutes(routes, { initialEntries: ['/inside'] })

    await screen.findByRole('heading', { level: 1, name: 'داخل المبنى الآن' })
    const print = await waitFor(() => printView())
    // The sheet itself carries no margin of its own (it was `lg:print:-ml-64`, which pulled the
    // right-to-left sheet 256 px off the left edge); the layout drops the sidebar's room on paper.
    expect(print.className).not.toMatch(/-m[lrse]-|print:-m/)
    expect(Array.from(print.querySelectorAll('th')).map((cell) => cell.textContent)).toEqual([
      'م',
      'الزائر',
      'هاتف الزائر',
      'الشركة',
      'المضيف',
      'هاتف المضيف',
      'القسم',
      'وقت الدخول',
      'ملاحظات',
      'حاضر',
    ])
    expect(print).toHaveTextContent('قائمة الإخلاء: الزوار في الموقع')
    expect(print).toHaveTextContent('عدد الموجودين: 2')
    expect(print).toHaveTextContent('تاريخ الإنشاء: الاثنين، 5 تشرين الأول 2026 الساعة 09:31:05، توقيت عمّان (UTC+3).')
    // Who printed it, without a verb that agrees with a man (review): «طُبعت بواسطة …».
    expect(print).toHaveTextContent('طُبعت بواسطة Lina Haddad.')
    // No-break spaces keep each date's day, month and year on one line; read as spaces here.
    const rows = Array.from(print.querySelectorAll('tbody tr')).map((row) => Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent?.replaceAll('\u00a0', ' ')))
    expect(rows[0]?.slice(7, 9)).toEqual(['السبت، 3 تشرين الأول 2026، 17:40', 'من يوم سابق، تجاوز وقت المغادرة'])
    // The company's own logo heads the sheet (Phase 12), never the product's.
    expect(print.querySelector('img[data-company-logo="light"]')).toHaveAttribute('src', brand.logo_url)
    expect(print.querySelector('[data-brand-logo]')).toBeNull()
  })

  it('dials every phone as it is shown, Arabic-Indic digits too, and shows it in stored order (SEC-33)', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    // Typed on Arabic keyboards: the server accepts these digits, also mixed with ASCII ones.
    const hostPhone = '٠٧٩ ٥٠٠ ١٠٠٢'
    const visitorPhone = '+962 79 ٥٠٠ 1003'
    const visit = makeVisit({ ...overdue, host: { ...overdue.host, phone: hostPhone } })
    setup(() => jsonResponse({ count: 1, items: [makeInsideVisit(visit, visitorPhone)] }))
    await screen.findByRole('table', { name: 'Visitors inside now' })

    // Every link to call someone: the visitor and the host.
    const links = screen.getAllByRole('link', { name: /^Call / })
    expect(links.map((link) => link.getAttribute('href')).toSorted()).toEqual(['tel:+962795001003', 'tel:0795001002'])
    for (const link of links) {
      const shown = link.textContent ?? ''
      expect([hostPhone, visitorPhone]).toContain(shown)
      // The digits dialled are the digits shown, in the order shown.
      expect(link.getAttribute('href')).toBe(`tel:${asciiDigits(shown).replace(/[^\d+]/g, '')}`)
      // Laid out left to right in stored order: a space between Arabic-Indic digit groups would
      // otherwise reverse the groups, even on this left-to-right page.
      const number = link.querySelector('bdo')
      expect(number).toHaveAttribute('dir', 'ltr')
      expect(number).toHaveClass('[unicode-bidi:isolate-override]')
      expect(number).toHaveTextContent(shown)
    }

    // On paper as well.
    const cells = Array.from(printView().querySelectorAll('tbody td bdo'))
    expect(cells.map((cell) => [cell.getAttribute('dir'), cell.textContent])).toEqual([
      ['ltr', visitorPhone],
      ['ltr', hostPhone],
    ])
  })

  it('refreshes every 15 seconds without keeping an idle session alive', async () => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true })
    const { requests } = setup()
    await screen.findByRole('table', { name: 'Visitors inside now' })
    expect(insideRequests(requests)).toHaveLength(1)
    // The first load is the person's own navigation.
    expect(insideRequests(requests)[0]!.headers.get('X-Background-Refresh')).toBeNull()

    await vi.advanceTimersByTimeAsync(15_000)
    await waitFor(() => expect(insideRequests(requests)).toHaveLength(2))
    expect(insideRequests(requests)[1]!.headers.get('X-Background-Refresh')).toBe('1')
  })

  it('fetches the current list before printing, and prints it', async () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {})
    let current = [overdue]
    const { requests, user } = setup(() => jsonResponse(inside(current)))
    await screen.findByRole('link', { name: 'Zara Haddad' })
    let headcountWhenPrinted = ''
    printSpy.mockImplementation(() => {
      headcountWhenPrinted = printView().querySelector('header')?.textContent ?? ''
    })

    current = [overdue, stale]
    await user.click(screen.getByRole('button', { name: 'Print list' }))

    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1))
    expect(headcountWhenPrinted).toContain('Headcount: 2')
    const printFetch = insideRequests(requests).at(-1)!
    expect(printFetch.headers.get('X-Background-Refresh')).toBeNull()
  })

  it('keeps the last list, with its time, when a refresh fails', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    let fail = false
    const { user } = setup(() => (fail ? errorResponse(503, 'SERVICE_BUSY', 'The service is busy. Please try again.') : jsonResponse(inside([overdue]))))
    await screen.findByRole('link', { name: 'Zara Haddad' })

    fail = true
    await user.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(await screen.findByText('The list could not be refreshed')).toBeInTheDocument()
    expect(screen.getByText(/It shows who was inside at 09:31:05\./)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Zara Haddad' })).toBeInTheDocument()
  })

  it('says when nobody is inside, on screen and on paper', async () => {
    setup(() => jsonResponse(inside([])))

    expect(await screen.findByRole('heading', { name: 'Nobody is checked in' })).toBeInTheDocument()
    expect(printView()).toHaveTextContent('Headcount: 0')
    expect(printView()).toHaveTextContent('No visitors are checked in.')
  })

  it('explains a failed first load and retries', async () => {
    let fail = true
    const { user } = setup(() => (fail ? errorResponse(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.') : jsonResponse(inside([stale]))))

    expect(await screen.findByText('The list of visitors inside could not be loaded')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Print list' })).toBeDisabled()
    fail = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: 'Adam Noor' })).toBeInTheDocument()
  })

  it('is open to management and administrators too', async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['MANAGEMENT'])), 'GET /reception/inside': () => jsonResponse(inside([stale])) })
    const { router } = renderRoutes(routes, { initialEntries: ['/inside'] })
    expect(await screen.findByRole('link', { name: 'Adam Noor' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/inside')
  })
})

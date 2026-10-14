import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIST_POLL_MS } from '../../api/queries'
import { i18n } from '../../i18n'
import { errorResponse, jsonResponse } from '../../test/api'
import { makeSearchItem, page } from '../../test/fixtures'
import { buttonClassName } from '../../components/ui/buttonStyles'
import { findAlert } from '../../test/render'
import type { Visit, VisitorSearchItem } from '../../types/api'
import {
  checkedOutVisit,
  insideVisit,
  makeInside,
  makeToday,
  PASS_TOKEN,
  readyScan,
  RECEPTION_NOW,
  RECEPTIONIST,
  receptionVisit,
} from './testing/receptionFixtures'
import { renderReception, requestsTo } from './testing/renderReception'

const NO_VISIT_TODAY = 'No visit to check in or out today.'

const EARLY_ID = '5a1b2c3d-0000-4000-8000-000000000002'
const NO_SHOW_ID = '5a1b2c3d-0000-4000-8000-000000000003'
const STALE_ID = '5a1b2c3d-0000-4000-8000-000000000004'

/** Due now (window 08:00–11:00), early (window from 13:00) and a no-show of this morning. */
function expectedVisits(): { expected: Visit[]; no_show: Visit[] } {
  return {
    expected: [
      receptionVisit(),
      receptionVisit({
        id: EARLY_ID,
        visitor: { id: 'v2', full_name: 'Karim Nasser', company_name: 'Blue Ridge' },
        purpose: 'Interview',
        scheduled_start: '2026-10-06T11:00:00Z',
        scheduled_end: '2026-10-06T12:00:00Z',
        window_start: '2026-10-06T10:00:00Z',
        window_end: '2026-10-06T13:00:00Z',
      }),
    ],
    no_show: [
      receptionVisit({
        id: NO_SHOW_ID,
        status: 'NO_SHOW',
        visitor: { id: 'v3', full_name: 'Sara Haddad', company_name: null },
        scheduled_start: '2026-10-06T03:00:00Z',
        scheduled_end: '2026-10-06T03:30:00Z',
        window_start: '2026-10-06T02:00:00Z',
        window_end: '2026-10-06T04:30:00Z',
        no_show_at: '2026-10-06T04:31:00Z',
      }),
    ],
  }
}

/** Inside now: one from this morning, one left over from yesterday. */
function inside(): Visit[] {
  return [
    insideVisit(),
    insideVisit({
      id: STALE_ID,
      visitor: { id: 'v4', full_name: 'Lina Odeh', company_name: 'Northwind' },
      check_in_at: '2026-10-05T07:00:00Z',
      scheduled_start: '2026-10-05T06:30:00Z',
      scheduled_end: '2026-10-05T08:00:00Z',
      is_stale: true,
      is_overdue: true,
    }),
  ]
}

/** One visitor with a visit today, one without. */
function searchItems(): VisitorSearchItem[] {
  return [
    makeSearchItem({ today_visits: [receptionVisit()] }),
    makeSearchItem({ id: 'v5', full_name: 'Elias Haddad', email: 'elias@example.com', company_name: null, phone: null, today_visits: [] }),
  ]
}

function row(name: string): HTMLElement {
  const item = screen.getByText(name).closest('li')
  if (!item) throw new Error(`No row for ${name}`)
  return item
}

/** Opens "Find a visitor" from the screen's header and returns the search field in its dialog. */
async function openSearch(user: ReturnType<typeof renderReception>['user']) {
  await user.click(await screen.findByRole('button', { name: 'Find a visitor' }))
  const dialog = await screen.findByRole('dialog', { name: 'Find a visitor' })
  return within(dialog).getByRole('searchbox', { name: 'Find a visitor' })
}

beforeEach(() => {
  vi.useFakeTimers({ now: RECEPTION_NOW, toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('reception screen', () => {
  it('shows today’s counts and keeps the selected tab in the URL', async () => {
    const { user, router } = renderReception({
      camera: { permission: 'prompt' },
      routes: { 'GET /reception/today': () => jsonResponse(makeToday({ ...expectedVisits(), inside: [insideVisit()] }, { checked_out: 4 })) },
    })

    // Today's numbers as direction C's KPI tiles (label over number); expected and inside are also the tabs' badges.
    const counts = await screen.findByRole('region', { name: 'Today at reception' })
    await waitFor(() => expect(counts).not.toHaveAttribute('aria-busy', 'true'))
    const tile = (label: string) => within(counts).getByText(label).closest('[data-count]') as HTMLElement
    expect(tile('Expected')).toHaveTextContent(/^Expected2$/)
    expect(tile('Inside')).toHaveTextContent(/^Inside1Live$/)
    expect(tile('Checked out')).toHaveTextContent(/^Checked out4$/)
    // The sign-out icon points the reading direction's way, as on the chips and buttons (mirrored in Arabic).
    expect(tile('Checked out').querySelector('svg')).toHaveClass('mirror-rtl')
    expect(tile('Expected').querySelector('svg')).not.toHaveClass('mirror-rtl')
    expect(tile('No-shows')).toHaveTextContent(/^No-shows1$/)
    expect(tile('Walk-ins')).toHaveTextContent(/^Walk-ins0$/)
    expect(screen.getByRole('tab', { name: 'Scan' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Expected 2' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Inside 1' })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Expected 2' }))
    expect(router.state.location.search).toBe('?tab=expected')
    await user.click(screen.getByRole('tab', { name: 'Scan' }))
    expect(router.state.location.search).toBe('')
  })

  it('polls today’s counts every 15 s as a background refresh (X-Background-Refresh: 1)', async () => {
    vi.useRealTimers()
    vi.useFakeTimers({ now: RECEPTION_NOW, shouldAdvanceTime: true })
    const { requests } = renderReception({ camera: { permission: 'prompt' } })
    await waitFor(() => expect(requestsTo(requests, 'GET', '/reception/today')).toHaveLength(1))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIST_POLL_MS)
    })
    await waitFor(() => expect(requestsTo(requests, 'GET', '/reception/today')).toHaveLength(2))

    const [first, second] = requestsTo(requests, 'GET', '/reception/today')
    // The first load is the user's own request; the poll does not keep an idle session alive (§7.2).
    expect(first?.headers.get('X-Background-Refresh')).toBeNull()
    expect(second?.headers.get('X-Background-Refresh')).toBe('1')
  })
})

describe('Expected tab', () => {
  it('lists today’s expected visitors with their arrival state, and today’s no-shows', async () => {
    renderReception({
      initialEntry: '/reception?tab=expected',
      camera: { permission: 'prompt' },
      routes: { 'GET /reception/today': () => jsonResponse(makeToday(expectedVisits())) },
    })

    expect(await screen.findByText('Élodie Martin')).toBeInTheDocument()
    expect(row('Élodie Martin')).toHaveTextContent('09:00–\u206010:00')
    expect(within(row('Élodie Martin')).getByText('Expected now')).toBeInTheDocument()
    expect(within(row('Élodie Martin')).getByRole('link', { name: 'Call Omar Khalil: +962 79 000 0077' })).toBeInTheDocument()
    expect(within(row('Karim Nasser')).getByText('Pass valid from 13:00')).toBeInTheDocument()
    expect(within(row('Élodie Martin')).getByRole('button', { name: 'Verify ID & check in' })).toBeInTheDocument()
    // An early check-in is the audited exception: in the row's menu, not a button on every later row.
    expect(within(row('Karim Nasser')).queryByRole('button', { name: 'Check in anyway…' })).toBeNull()
    const menu = within(row('Karim Nasser')).getByRole('button', { name: 'More actions for Karim Nasser' })
    // On phones the menu sits in the card's corner, so a row without a button adds no line for it.
    const corner = menu.closest('[data-row-menu]') as HTMLElement
    expect(corner.className).toContain('max-sm:absolute')
    expect(corner.parentElement?.className).toContain('max-sm:contents')
    expect(row('Karim Nasser').className).toContain('relative')

    // Grouped, each group with its count.
    const arriving = screen.getByRole('heading', { name: 'Arriving now 1' }).closest('section') as HTMLElement
    expect(within(arriving).getByText('Élodie Martin')).toBeInTheDocument()
    const later = screen.getByRole('heading', { name: 'Later today 1' }).closest('section') as HTMLElement
    expect(within(later).getByText('Karim Nasser')).toBeInTheDocument()
    const noShows = screen.getByRole('heading', { name: 'No-shows today 1' }).closest('section') as HTMLElement
    expect(within(noShows).getByText('Sara Haddad')).toBeInTheDocument()
    expect(within(noShows).getByRole('button', { name: 'Check in anyway…' })).toBeInTheDocument()
  })

  it('times a visit that ends after midnight from its start alone (a list of today’s visits needs no dates)', async () => {
    // 23:30–00:15 company time (Asia/Amman, UTC+3): the list is today's, so no dates.
    const lateEvening = receptionVisit({
      id: EARLY_ID,
      visitor: { id: 'v2', full_name: 'Karim Nasser', company_name: 'Blue Ridge' },
      scheduled_start: '2026-10-06T20:30:00Z',
      scheduled_end: '2026-10-06T21:15:00Z',
      window_start: '2026-10-06T19:30:00Z',
      window_end: '2026-10-06T22:15:00Z',
    })
    renderReception({
      initialEntry: '/reception?tab=expected',
      camera: { permission: 'prompt' },
      routes: { 'GET /reception/today': () => jsonResponse(makeToday({ expected: [receptionVisit(), lateEvening], no_show: [] })) },
    })

    expect(await screen.findByText('Karim Nasser')).toBeInTheDocument()
    expect(row('Karim Nasser')).toHaveTextContent('from 23:30')
    expect(row('Karim Nasser')).not.toHaveTextContent('Tue, 6 Oct')
  })

  it('keeps an Arabic host and department apart in the English list: each is an isolate after "Host" (review)', async () => {
    const arabicData = receptionVisit({
      host: { ...receptionVisit().host, full_name: 'عمر خليل' },
      department: { id: '7f0d1c0e-1111-4a5b-9c1d-0000000000d9', name: 'العمليات', name_ar: null },
    })
    renderReception({
      initialEntry: '/reception?tab=expected',
      camera: { permission: 'prompt' },
      routes: { 'GET /reception/today': () => jsonResponse(makeToday({ expected: [arabicData], no_show: [] })) },
    })
    expect(await screen.findByText('Élodie Martin')).toBeInTheDocument()
    const line = within(row('Élodie Martin')).getByText('عمر خليل').closest('span.break-words') as HTMLElement
    expect(line).toHaveTextContent('Host عمر خليل · العمليات')
    // Two isolates side by side (the host's, holding the name's own, and the department's), so the bidi
    // algorithm cannot join the two Arabic values into one right-to-left run ("Host العمليات · عمر خليل").
    const isolates = [...line.children].filter((child) => child.tagName === 'BDI')
    expect(isolates.map((isolate) => isolate.textContent)).toEqual(['Host عمر خليل', 'العمليات'])
    expect(isolates[0]!.querySelector('bdi')).toHaveTextContent('عمر خليل')
    // The purpose in its own direction, so a cut-off purpose loses its end, not its start.
    expect(within(row('Élodie Martin')).getByTitle(arabicData.purpose)).toHaveAttribute('dir', 'auto')
  })

  it('lets the Expected row’s action wrap inside its card on phones (an Arabic label is wider than a 360 px card)', async () => {
    renderReception({
      initialEntry: '/reception?tab=expected',
      camera: { permission: 'prompt' },
      routes: { 'GET /reception/today': () => jsonResponse(makeToday(expectedVisits())) },
    })
    expect(await screen.findByText('Élodie Martin')).toBeInTheDocument()
    const button = within(row('Élodie Martin')).getByRole('button', { name: 'Verify ID & check in' })
    expect(button.parentElement).toHaveClass('max-sm:min-w-0', 'max-sm:[&>*]:whitespace-normal', 'max-sm:[&>*]:w-full')
  })

  it('is Arabic around the visitors’ own details for an Arabic receptionist (phase 10 review)', async () => {
    await i18n.changeLanguage('ar')
    renderReception({
      initialEntry: '/reception?tab=expected',
      camera: { permission: 'prompt' },
      routes: {
        'GET /auth/me': () => jsonResponse({ ...RECEPTIONIST, user: { ...RECEPTIONIST.user, preferred_language: 'ar' } }),
        'GET /reception/today': () => jsonResponse(makeToday(expectedVisits())),
      },
    })

    expect(await screen.findByText('Élodie Martin')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'الاستقبال' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'المتوقعون 2' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: 'يصلون الآن 1' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'لاحقًا اليوم 1' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'لم يحضروا اليوم 1' })).toBeInTheDocument()
    // Every Latin word left on the screen is data: names, companies, departments, purposes.
    const data = new Set(
      expectedVisits()
        .expected.concat(expectedVisits().no_show)
        .flatMap((visit) => [visit.visitor.full_name, visit.visitor.company_name, visit.host.full_name, visit.department?.name, visit.purpose])
        .join(' ')
        .match(/[\p{Script=Latin}]+/gu),
    )
    // The time zone's name stays UTC in Arabic too (the catalogs' convention).
    data.add('UTC')
    const latin: string[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) latin.push(...(node.textContent?.match(/[\p{Script=Latin}]{3,}/gu) ?? []))
    expect(latin.filter((word) => !data.has(word))).toEqual([])
  })

  it('filters the list inline by visitor, company, host or purpose', async () => {
    const { user } = renderReception({
      initialEntry: '/reception?tab=expected',
      camera: { permission: 'prompt' },
      routes: { 'GET /reception/today': () => jsonResponse(makeToday(expectedVisits())) },
    })
    await screen.findByText('Élodie Martin')

    await user.type(screen.getByRole('searchbox', { name: 'Filter expected visitors' }), 'interview')
    expect(screen.queryByText('Élodie Martin')).toBeNull()
    expect(screen.getByText('Karim Nasser')).toBeInTheDocument()

    await user.clear(screen.getByRole('searchbox', { name: 'Filter expected visitors' }))
    await user.type(screen.getByRole('searchbox', { name: 'Filter expected visitors' }), 'zzz')
    expect(screen.getByText('No expected visitor matches “zzz”')).toBeInTheDocument()
  })

  it('checks a visitor in after an ID check (MANUAL) and refreshes the list', async () => {
    const { user, requests } = renderReception({
      initialEntry: '/reception?tab=expected',
      camera: { permission: 'prompt' },
      routes: {
        'GET /reception/today': () => jsonResponse(makeToday(expectedVisits())),
        [`POST /visits/${receptionVisit().id}/check-in`]: () => jsonResponse(insideVisit()),
      },
    })
    await screen.findByText('Élodie Martin')

    await user.click(within(row('Élodie Martin')).getByRole('button', { name: 'Verify ID & check in' }))
    const dialog = await screen.findByRole('dialog', { name: 'Verify ID and check in' })
    expect(dialog).toHaveTextContent('Verify ID: Élodie Martin')
    expect(within(dialog).getByRole('button', { name: 'Check in' })).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: 'Check in' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(requestsTo(requests, 'POST', `/visits/${receptionVisit().id}/check-in`).map((request) => request.body)).toEqual([{ method: 'MANUAL' }])
    expect(await screen.findByText('Élodie Martin checked in')).toBeInTheDocument()
    await waitFor(() => expect(requestsTo(requests, 'GET', '/reception/today').length).toBeGreaterThan(1))
  })

  it('keeps keyboard focus in the list when the checked-in visitor leaves it (WCAG 2.4.3)', async () => {
    let checkedIn = false
    const { user } = renderReception({
      initialEntry: '/reception?tab=expected',
      camera: { permission: 'prompt' },
      routes: {
        'GET /reception/today': () => {
          const { expected, no_show } = expectedVisits()
          return jsonResponse(makeToday({ expected: checkedIn ? expected.slice(1) : expected, no_show }))
        },
        [`POST /visits/${receptionVisit().id}/check-in`]: () => {
          checkedIn = true
          return jsonResponse(insideVisit())
        },
      },
    })
    await screen.findByText('Élodie Martin')

    within(row('Élodie Martin')).getByRole('button', { name: 'Verify ID & check in' }).focus()
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('dialog', { name: 'Verify ID and check in' })
    await user.keyboard('{Enter}')
    await waitFor(() => expect(dialog).not.toBeInTheDocument())

    // The row is gone once the list is refreshed; focus moves on to the next visitor's row, not the page.
    await waitFor(() => expect(screen.queryByText('Élodie Martin')).toBeNull())
    await waitFor(() => expect(document.activeElement).not.toBe(document.body))
    expect(screen.getByRole('button', { name: 'More actions for Karim Nasser' })).toHaveFocus()
  })

  it('checks an early visitor in anyway (OVERRIDE) with a reason', async () => {
    const { user, requests } = renderReception({
      initialEntry: '/reception?tab=expected',
      camera: { permission: 'prompt' },
      routes: {
        'GET /reception/today': () => jsonResponse(makeToday(expectedVisits())),
        [`POST /visits/${EARLY_ID}/check-in`]: () => jsonResponse(insideVisit({ id: EARLY_ID })),
      },
    })
    await screen.findByText('Karim Nasser')

    await user.click(within(row('Karim Nasser')).getByRole('button', { name: 'More actions for Karim Nasser' }))
    await user.click(screen.getByRole('menuitem', { name: 'Check in anyway…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Check in anyway' })
    expect(dialog).toHaveAccessibleDescription(/The pass is valid from 13:00\./)
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), '  Interview moved earlier ')
    await user.click(within(dialog).getByRole('button', { name: 'Check in anyway' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(requestsTo(requests, 'POST', `/visits/${EARLY_ID}/check-in`).map((request) => request.body)).toEqual([
      { method: 'OVERRIDE', reason: 'Interview moved earlier' },
    ])
  })

  it('fills the override reason with a common reason in one tap, which stays editable; "Other" moves to the field', async () => {
    const { user, requests } = renderReception({
      initialEntry: '/reception?tab=expected',
      camera: { permission: 'prompt' },
      routes: {
        'GET /reception/today': () => jsonResponse(makeToday(expectedVisits())),
        [`POST /visits/${EARLY_ID}/check-in`]: () => jsonResponse(insideVisit({ id: EARLY_ID })),
      },
    })
    await screen.findByText('Karim Nasser')
    await user.click(within(row('Karim Nasser')).getByRole('button', { name: 'More actions for Karim Nasser' }))
    await user.click(screen.getByRole('menuitem', { name: 'Check in anyway…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Check in anyway' })
    const reason = within(dialog).getByRole('textbox', { name: 'Reason' })
    const early = within(dialog).getByRole('button', { name: 'Arrived early – host confirmed' })
    // An early visitor: the late arrival is not offered.
    expect(within(dialog).queryByRole('button', { name: 'Arrived late – host confirmed' })).toBeNull()
    expect(early).toHaveFocus()
    expect(early).toHaveAttribute('aria-pressed', 'false')

    await user.click(within(dialog).getByRole('button', { name: 'Did not receive the pass' }))
    expect(reason).toHaveValue('Did not receive the pass')
    await user.click(within(dialog).getByRole('button', { name: 'Other' }))
    expect(reason).toHaveValue('')
    expect(reason).toHaveFocus()

    await user.click(early)
    expect(reason).toHaveValue('Arrived early – host confirmed')
    expect(early).toHaveAttribute('aria-pressed', 'true')
    await user.type(reason, ' for the 13:00 interview')
    expect(early).toHaveAttribute('aria-pressed', 'false')
    await user.click(within(dialog).getByRole('button', { name: 'Check in anyway' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(requestsTo(requests, 'POST', `/visits/${EARLY_ID}/check-in`).map((request) => request.body)).toEqual([
      { method: 'OVERRIDE', reason: 'Arrived early – host confirmed for the 13:00 interview' },
    ])
  })

  it('shows the server’s message when a check-in is refused', async () => {
    const { user } = renderReception({
      initialEntry: '/reception?tab=expected',
      camera: { permission: 'prompt' },
      routes: {
        'GET /reception/today': () => jsonResponse(makeToday(expectedVisits())),
        [`POST /visits/${receptionVisit().id}/check-in`]: () =>
          errorResponse(409, 'VISITOR_ALREADY_INSIDE', 'This visitor is already checked in on another visit.'),
      },
    })
    await screen.findByText('Élodie Martin')
    await user.click(within(row('Élodie Martin')).getByRole('button', { name: 'Verify ID & check in' }))
    const dialog = await screen.findByRole('dialog', { name: 'Verify ID and check in' })
    await user.click(within(dialog).getByRole('button', { name: 'Check in' }))

    expect(await findAlert('This visitor is already checked in on another visit.')).toBeInTheDocument()
  })
})

describe('Inside tab', () => {

  it('lists everyone inside with check-in time, time inside, host and stale/overdue flags', async () => {
    renderReception({
      initialEntry: '/reception?tab=inside',
      camera: { permission: 'prompt' },
      routes: { 'GET /reception/inside': () => jsonResponse(makeInside(inside())) },
    })

    expect(await screen.findByText('2 visitors inside')).toBeInTheDocument()
    expect(row('Élodie Martin')).toHaveTextContent('Checked in 09:02 · 8m inside')
    expect(row('Lina Odeh')).toHaveTextContent('Checked in Mon, 5 Oct 2026, 10:00')
    // The words and tone of the evacuation list (/inside): both flags, neither hiding the other.
    expect(within(row('Lina Odeh')).getByText('Previous day')).toBeInTheDocument()
    expect(within(row('Lina Odeh')).getByText('Overdue')).toBeInTheDocument()
    expect(within(row('Élodie Martin')).queryByText('Previous day')).toBeNull()
    expect(screen.getByText('1 visitor from previous days is still checked in')).toBeInTheDocument()
    // The rare correction waits in each row's menu.
    expect(within(row('Élodie Martin')).queryByRole('button', { name: 'Correct check-out time' })).toBeNull()
  })

  it('checks a visitor out (MANUAL) in one tap (§10), with an outlined button', async () => {
    const { user, requests } = renderReception({
      initialEntry: '/reception?tab=inside',
      camera: { permission: 'prompt' },
      routes: {
        'GET /reception/inside': () => jsonResponse(makeInside(inside())),
        [`POST /visits/${insideVisit().id}/check-out`]: () => jsonResponse(checkedOutVisit()),
      },
    })
    await screen.findByText('2 visitors inside')

    const checkOut = within(row('Élodie Martin')).getByRole('button', { name: 'Check out' })
    // Solid primary is a check-in's style; a check-out is outlined, as on the scanner.
    expect(checkOut.className).toBe(buttonClassName({ variant: 'secondary', size: 'lg' }))
    await user.click(checkOut)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(await screen.findByText('Élodie Martin checked out')).toBeInTheDocument()
    expect(requestsTo(requests, 'POST', `/visits/${insideVisit().id}/check-out`).map((request) => request.body)).toEqual([{ method: 'MANUAL' }])
    await waitFor(() => expect(requestsTo(requests, 'GET', '/reception/inside').length).toBeGreaterThan(1))
  })

  it('asks first before checking out a visitor checked in less than 5 minutes ago', async () => {
    const recent = insideVisit({ check_in_at: '2026-10-06T06:07:00Z' })
    const { user, requests } = renderReception({
      initialEntry: '/reception?tab=inside',
      camera: { permission: 'prompt' },
      routes: {
        'GET /reception/inside': () => jsonResponse(makeInside([recent])),
        [`POST /visits/${recent.id}/check-out`]: () => jsonResponse(checkedOutVisit()),
      },
    })
    await screen.findByText('1 visitor inside')

    await user.click(within(row('Élodie Martin')).getByRole('button', { name: 'Check out' }))
    const dialog = await screen.findByRole('dialog', { name: 'Check out Élodie Martin?' })
    expect(within(dialog).getByText('Checked in 3m ago')).toBeInTheDocument()
    // Probably someone arriving: Cancel has focus, and nothing was sent yet.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(requestsTo(requests, 'POST', `/visits/${recent.id}/check-out`)).toHaveLength(0)

    await user.click(within(dialog).getByRole('button', { name: 'Check out' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(requestsTo(requests, 'POST', `/visits/${recent.id}/check-out`).map((request) => request.body)).toEqual([{ method: 'MANUAL' }])
  })

  it('says why a one-tap check-out was refused and refreshes the list', async () => {
    const { user, requests } = renderReception({
      initialEntry: '/reception?tab=inside',
      camera: { permission: 'prompt' },
      routes: {
        'GET /reception/inside': () => jsonResponse(makeInside(inside())),
        [`POST /visits/${insideVisit().id}/check-out`]: () =>
          errorResponse(409, 'VISIT_COMPLETED', 'The visitor has already checked out.'),
      },
    })
    await screen.findByText('2 visitors inside')

    await user.click(within(row('Élodie Martin')).getByRole('button', { name: 'Check out' }))
    const alert = await findAlert('Élodie Martin was not checked out')
    expect(alert).toHaveTextContent('The visitor has already checked out.')
    await waitFor(() => expect(requestsTo(requests, 'GET', '/reception/inside').length).toBeGreaterThan(1))
  })

  it('shows why a walk-in was let in when checking them out (B57-64: the note of reason OTHER)', async () => {
    const walkIn = insideVisit({
      check_in_at: '2026-10-06T06:08:00Z',
      check_in_method: 'WALK_IN',
      is_walk_in: true,
      walk_in_reason: 'OTHER',
      check_in_note: 'Courier for the legal team,\nwaiting for a signature',
    })
    const { user } = renderReception({
      initialEntry: '/reception?tab=inside',
      camera: { permission: 'prompt' },
      routes: { 'GET /reception/inside': () => jsonResponse(makeInside([walkIn])) },
    })
    await screen.findByText('1 visitor inside')

    await user.click(within(row('Élodie Martin')).getByRole('button', { name: 'Check out' }))
    const dialog = await screen.findByRole('dialog', { name: 'Check out Élodie Martin?' })
    const facts = within(dialog).getByText('Walk-in').closest('dl') as HTMLElement
    expect(facts).toHaveTextContent('Walk-inOtherNoteCourier for the legal team, waiting for a signatureChecked in09:08 · 2m inside')
    expect(within(facts).getByText(/Courier for the legal team/)).toHaveClass('whitespace-pre-wrap')
  })

  it('moves focus to the next visitor’s Check out when the checked-out row disappears (WCAG 2.4.3)', async () => {
    let checkedOut = false
    const { user } = renderReception({
      initialEntry: '/reception?tab=inside',
      camera: { permission: 'prompt' },
      routes: {
        'GET /reception/inside': () => jsonResponse(makeInside(checkedOut ? inside().slice(1) : inside())),
        [`POST /visits/${insideVisit().id}/check-out`]: () => {
          checkedOut = true
          return jsonResponse(checkedOutVisit())
        },
      },
    })
    await screen.findByText('2 visitors inside')

    within(row('Élodie Martin')).getByRole('button', { name: 'Check out' }).focus()
    await user.keyboard('{Enter}')

    await screen.findByText('1 visitor inside')
    await waitFor(() => expect(within(row('Lina Odeh')).getByRole('button', { name: 'Check out' })).toHaveFocus())
  })

  it('corrects the check-out time (CORRECTED) with a time and a required note', async () => {
    const { user, requests } = renderReception({
      initialEntry: '/reception?tab=inside',
      camera: { permission: 'prompt' },
      routes: {
        'GET /reception/inside': () => jsonResponse(makeInside(inside())),
        [`POST /visits/${STALE_ID}/check-out`]: () => jsonResponse(checkedOutVisit({ id: STALE_ID })),
      },
    })
    await screen.findByText('2 visitors inside')

    await user.click(within(row('Lina Odeh')).getByRole('button', { name: 'More actions for Lina Odeh' }))
    await user.click(screen.getByRole('menuitem', { name: 'Correct check-out time' }))
    const dialog = await screen.findByRole('dialog', { name: 'Correct check-out time' })
    // Defaults to the scheduled end: Mon 5 Oct, 11:00 Amman.
    expect(within(dialog).getByLabelText('Left at date')).toHaveValue('2026-10-05')
    expect(within(dialog).getByRole('combobox', { name: 'Left at time' })).toHaveValue('11:00')

    await user.click(within(dialog).getByRole('button', { name: 'Save check-out' }))
    expect(await within(dialog).findByText(/Explain the correction/)).toBeInTheDocument()
    expect(requestsTo(requests, 'POST', `/visits/${STALE_ID}/check-out`)).toHaveLength(0)

    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Left at time' }), '12:30')
    await user.type(within(dialog).getByRole('textbox', { name: 'Note' }), 'Left without checking out')
    await user.click(within(dialog).getByRole('button', { name: 'Save check-out' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(requestsTo(requests, 'POST', `/visits/${STALE_ID}/check-out`).map((request) => request.body)).toEqual([
      { method: 'CORRECTED', check_out_at: '2026-10-05T09:30:00.000Z', note: 'Left without checking out' },
    ])
  })

  it('checks out everyone left from previous days with one reason (bulk), saying who and when first', async () => {
    let bulkDone = false
    const { user, requests } = renderReception({
      initialEntry: '/reception?tab=inside',
      camera: { permission: 'prompt' },
      routes: {
        'GET /reception/inside': () => jsonResponse(makeInside(bulkDone ? inside().slice(0, 1) : inside())),
        'POST /reception/check-out-stale': () => {
          bulkDone = true
          return jsonResponse({ checked_out: 1 })
        },
      },
    })
    await screen.findByText('2 visitors inside')

    screen.getByRole('button', { name: 'Check out remaining from previous days' }).focus()
    await user.keyboard('{Enter}')
    const dialog = await screen.findByRole('alertdialog', { name: 'Check out visitors from previous days' })
    // One sentence, as an irreversible action keeps (decision 3); the list below says who and when.
    expect(dialog).toHaveAccessibleDescription('This cannot be undone.')
    // Who is checked out, and at what time (the scheduled end: Mon 5 Oct, 11:00 Amman).
    const who = within(dialog).getByRole('heading', { name: 'Who is checked out' }).closest('section') as HTMLElement
    expect(who).toHaveTextContent('Lina Odeh')
    expect(who).toHaveTextContent('Host Omar Khalil · in Mon, 5 Oct 2026, 10:00')
    expect(who).toHaveTextContent('Out Mon, 5 Oct 2026, 11:00')
    const confirm = within(dialog).getByRole('button', { name: 'Check out 1 visitor' })
    await user.click(confirm)
    expect(await within(dialog).findByText(/Enter why these visitors are checked out/)).toBeInTheDocument()

    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Building closed overnight')
    await user.click(confirm)

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(requestsTo(requests, 'POST', '/reception/check-out-stale').map((request) => request.body)).toEqual([{ reason: 'Building closed overnight' }])
    expect(await screen.findByText('1 visitor checked out')).toBeInTheDocument()
    // The banner and its button are gone with the refreshed list: focus goes to the filter, not the page.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Check out remaining from previous days' })).toBeNull())
    await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Filter visitors inside' })).toHaveFocus())
  })

  it('offers no bulk check-out when nobody is left from previous days', async () => {
    renderReception({
      initialEntry: '/reception?tab=inside',
      camera: { permission: 'prompt' },
      routes: { 'GET /reception/inside': () => jsonResponse(makeInside([insideVisit()])) },
    })
    await screen.findByText('1 visitor inside')
    expect(screen.queryByRole('button', { name: 'Check out remaining from previous days' })).toBeNull()
  })

  it('leaves a visitor from an earlier day whose visit has not ended out of the bulk check-out (B57-71)', async () => {
    // Checked in yesterday at 23:30, expected until 12:00 today: still under way at 09:10.
    const night = insideVisit({
      id: STALE_ID,
      visitor: { id: 'v4', full_name: 'Lina Odeh', company_name: null },
      check_in_at: '2026-10-05T20:30:00Z',
      scheduled_start: '2026-10-05T20:30:00Z',
      scheduled_end: '2026-10-06T09:00:00Z',
      is_stale: true,
      is_overdue: false,
    })
    renderReception({
      initialEntry: '/reception?tab=inside',
      camera: { permission: 'prompt' },
      routes: { 'GET /reception/inside': () => jsonResponse(makeInside([insideVisit(), night])) },
    })
    await screen.findByText('2 visitors inside')
    expect(within(row('Lina Odeh')).getByText('Previous day')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check out remaining from previous days' })).toBeNull()
  })
})

describe('Find a visitor', () => {
  it('shows matching visitors with an inline Check in for today’s visit, and a walk-in for the others', async () => {
    const { user, requests } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'GET /visitors': () => jsonResponse(page(searchItems())),
        [`POST /visits/${receptionVisit().id}/check-in`]: () => jsonResponse(insideVisit()),
      },
    })
    const search = await openSearch(user)
    expect(search).toHaveFocus()
    await user.type(search, 'eli')

    const results = await screen.findByRole('region', { name: 'Visitor search results' })
    expect(await within(results).findByText(NO_VISIT_TODAY)).toBeInTheDocument()
    // No notes under the results (decision 3 of the brand pass): the visitor, the fact, the action.
    expect(within(results).queryByText(/is listed under Expected|from the visit’s “More actions” menu/)).toBeNull()
    expect(requestsTo(requests, 'GET', '/visitors').at(-1)?.url.searchParams.get('q')).toBe('eli')
    // Without a visit today: the explanation first, then a quiet walk-in action.
    const walkIn = within(results).getByRole('button', { name: 'Register walk-in' })
    expect(within(results).getByText(NO_VISIT_TODAY).compareDocumentPosition(walkIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(walkIn.className).not.toContain('border')
    // The same label as the Expected list.
    expect(within(results).getByRole('list', { name: 'Visits of Élodie Martin to act on' })).toHaveTextContent('Expected now')

    await user.click(within(results).getByRole('button', { name: 'Verify ID & check in' }))
    const dialog = await screen.findByRole('dialog', { name: 'Verify ID and check in' })
    await user.click(within(dialog).getByRole('button', { name: 'Check in' }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument())
    expect(requestsTo(requests, 'POST', `/visits/${receptionVisit().id}/check-in`).map((request) => request.body)).toEqual([{ method: 'MANUAL' }])
    // The search refreshes, so the visit now offers Check out.
    await waitFor(() => expect(requestsTo(requests, 'GET', '/visitors').length).toBeGreaterThan(1))
  })

  it('lists the visitors reception can act on first, and keeps an early check-in in the row’s menu as Expected does', async () => {
    const [, early] = expectedVisits().expected
    const items = [
      makeSearchItem({ id: 'v-a', full_name: 'Amal Chen', email: null, phone: null, company_name: null, today_visits: [] }),
      makeSearchItem({ id: 'v-b', full_name: 'Bilal Chen', email: null, phone: null, company_name: null, today_visits: [] }),
      makeSearchItem({
        id: 'v-i',
        full_name: 'Ingrid Chen',
        email: null,
        phone: null,
        company_name: null,
        today_visits: [{ ...early!, visitor: { id: 'v-i', full_name: 'Ingrid Chen', company_name: null } }],
      }),
      makeSearchItem({ id: 'v-z', full_name: 'Zaid Chen', email: null, phone: null, company_name: null, today_visits: [insideVisit({ id: 'inside' })] }),
    ]
    const { user, requests } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'GET /visitors': () => jsonResponse(page(items)),
        [`POST /visits/${EARLY_ID}/check-in`]: () => jsonResponse(insideVisit({ id: EARLY_ID })),
      },
    })
    // The server matched them; the typed text appears in none of the names, so none is split by a highlight.
    await user.type(await openSearch(user), 'qq')
    const results = await screen.findByRole('region', { name: 'Visitor search results' })
    await within(results).findByText('Zaid Chen')

    const names = within(results)
      .getAllByText(/ Chen$/, { selector: 'p' })
      .map((name) => name.textContent)
    expect(names).toEqual(['Zaid Chen', 'Ingrid Chen', 'Amal Chen', 'Bilal Chen'])

    const ingrid = within(results).getByRole('list', { name: 'Visits of Ingrid Chen to act on' })
    expect(ingrid).toHaveTextContent('Pass valid from 13:00')
    expect(within(ingrid).queryByRole('button', { name: 'Check in anyway…' })).toBeNull()
    await user.click(within(ingrid).getByRole('button', { name: 'More actions for Ingrid Chen' }))
    await user.click(screen.getByRole('menuitem', { name: 'Check in anyway…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Check in anyway' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Interview moved earlier')
    await user.click(within(dialog).getByRole('button', { name: 'Check in anyway' }))
    await waitFor(() => expect(requestsTo(requests, 'POST', `/visits/${EARLY_ID}/check-in`)).toHaveLength(1))
  })

  it('offers "Check in anyway…" for a late visitor whose visit today became a no-show, instead of a walk-in', async () => {
    const lists = expectedVisits()
    const { user, requests } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'GET /reception/today': () => jsonResponse(makeToday(lists)),
        // The search lists only SCHEDULED-today and CHECKED_IN visits (B24-11): not the no-show.
        'GET /visitors': () =>
          jsonResponse(page([makeSearchItem({ id: 'v3', full_name: 'Sara Haddad', email: null, company_name: null, phone: null, today_visits: [] })])),
        [`POST /visits/${NO_SHOW_ID}/check-in`]: () => jsonResponse(insideVisit({ id: NO_SHOW_ID })),
      },
    })
    await user.type(await openSearch(user), 'sara')
    const results = await screen.findByRole('region', { name: 'Visitor search results' })
    const visits = await within(results).findByRole('list', { name: 'Visits of Sara Haddad to act on' })

    expect(visits).toHaveTextContent('No-show · pass expired 07:30')
    expect(within(results).queryByText(NO_VISIT_TODAY)).toBeNull()
    expect(within(results).queryByRole('button', { name: 'Register walk-in' })).toBeNull()

    await user.click(within(visits).getByRole('button', { name: 'Check in anyway…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Check in anyway' })
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Arrived late, host confirmed')
    await user.click(within(dialog).getByRole('button', { name: 'Check in anyway' }))
    await waitFor(() =>
      expect(requestsTo(requests, 'POST', `/visits/${NO_SHOW_ID}/check-in`).map((request) => request.body)).toEqual([
        { method: 'OVERRIDE', reason: 'Arrived late, host confirmed' },
      ]),
    )
  })

  it('adds no note about late visitors while today’s no-shows are not all known here', async () => {
    const { user } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        // More no-shows than the list holds (it is capped at 200): this visitor's may be missing.
        'GET /reception/today': () => jsonResponse(makeToday({}, { no_show: 201 })),
        'GET /visitors': () => jsonResponse(page(searchItems())),
      },
    })
    await user.type(await openSearch(user), 'eli')
    const results = await screen.findByRole('region', { name: 'Visitor search results' })
    expect(await within(results).findByText(NO_VISIT_TODAY)).toBeInTheDocument()
    expect(within(results).getByRole('button', { name: 'Register walk-in' })).toBeInTheDocument()
    expect(results).not.toHaveTextContent(/No-shows today/)
  })

  it('offers Check out for a visitor who is inside', async () => {
    const { user, requests } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'GET /visitors': () => jsonResponse(page([makeSearchItem({ today_visits: [insideVisit()] })])),
        [`POST /visits/${insideVisit().id}/check-out`]: () => jsonResponse(checkedOutVisit()),
      },
    })
    await user.type(await openSearch(user), 'elodie')
    const results = await screen.findByRole('region', { name: 'Visitor search results' })
    await waitFor(() => expect(results).toHaveTextContent('Checked in 09:02 · 8m inside'))

    await user.click(within(results).getByRole('button', { name: 'Check out' }))
    const dialog = await screen.findByRole('dialog', { name: 'Check out Élodie Martin?' })
    await user.click(within(dialog).getByRole('button', { name: 'Check out' }))
    await waitFor(() => expect(requestsTo(requests, 'POST', `/visits/${insideVisit().id}/check-out`)).toHaveLength(1))
  })

  it('does not search for fewer than 2 characters', async () => {
    const { user, requests } = renderReception({ camera: { permission: 'prompt' } })
    await user.type(await openSearch(user), 'e')
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)))
    expect(requestsTo(requests, 'GET', '/visitors')).toHaveLength(0)
  })

  it('offers a walk-in for a visit that cannot be checked in, so the search never ends without a way forward', async () => {
    const inactiveHost = receptionVisit({ permissions: { can_check_in: false } })
    const { user, router } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'GET /visitors': () => jsonResponse(page([makeSearchItem({ today_visits: [inactiveHost] })])),
        'GET /departments': () => jsonResponse([]),
        [`GET /visitors/${inactiveHost.visitor.id}`]: () => jsonResponse(makeSearchItem()),
      },
    })
    await user.type(await openSearch(user), 'elodie')
    const results = await screen.findByRole('region', { name: 'Visitor search results' })
    const visits = await within(results).findByRole('list', { name: 'Visits of Élodie Martin to act on' })

    await user.click(within(visits).getByRole('button', { name: 'Register walk-in' }))
    // The search closes and the Walk-in tab opens with the visitor and purpose.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Find a visitor' })).toBeNull())
    expect(router.state.location.search).toBe('?tab=walk-in')
    expect(await screen.findByRole('textbox', { name: /^Purpose/ })).toHaveValue('Quarterly review')
  })

  it('shows at most five results at first, the rest behind "Show all"', async () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      makeSearchItem({ id: `v-${index}`, full_name: `Visitor ${index + 1}`, email: null, phone: null, company_name: null, today_visits: [] }),
    )
    const { user } = renderReception({ camera: { permission: 'prompt' }, routes: { 'GET /visitors': () => jsonResponse(page(many)) } })
    // The server matched them; the typed text appears in none of the names, so none is split by a highlight.
    await user.type(await openSearch(user), 'qq')
    const results = await screen.findByRole('region', { name: 'Visitor search results' })
    await within(results).findByText('Visitor 5')
    expect(within(results).queryByText('Visitor 6')).toBeNull()

    await user.click(within(results).getByRole('button', { name: 'Show all 7 results' }))
    expect(within(results).getByText('Visitor 7')).toBeInTheDocument()
  })

  it('closes when the camera reads a pass, so the result is not hidden behind it', async () => {
    const { user, scene } = renderReception({ routes: { 'POST /reception/scan': () => jsonResponse(readyScan()) } })
    await screen.findByText(/Point the camera at the visitor/)
    await openSearch(user)

    scene.show(`https://visitors.example.com/pass#${PASS_TOKEN}`)
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Find a visitor' })).toBeNull())
    expect(await screen.findByRole('button', { name: 'Check in' })).toBeInTheDocument()
  })
})

describe('scan result and the lists', () => {
  it('leaves a shown scan result once the same visitor is checked in from a list', async () => {
    const { user } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'POST /reception/scan': () => jsonResponse(readyScan()),
        'GET /reception/today': () => jsonResponse(makeToday(expectedVisits())),
        [`POST /visits/${receptionVisit().id}/check-in`]: () => jsonResponse(insideVisit()),
      },
    })
    const field = await screen.findByLabelText('Scan or paste a pass')
    await user.click(field)
    await user.paste(PASS_TOKEN)
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('button', { name: 'Check in' })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Expected 2' }))
    await user.click(within(row('Élodie Martin')).getByRole('button', { name: 'Verify ID & check in' }))
    const dialog = await screen.findByRole('dialog', { name: 'Verify ID and check in' })
    await user.click(within(dialog).getByRole('button', { name: 'Check in' }))
    await waitFor(() => expect(dialog).not.toBeInTheDocument())

    // Back on Scan, the result's "Check in" would only be refused now: it is gone.
    await user.click(screen.getByRole('tab', { name: 'Scan' }))
    expect(await screen.findByText('Ready to scan')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check in' })).toBeNull()
  })
})

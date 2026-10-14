import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { routes } from '../../test/appRoutes'
import { jsonResponse, makeMe, mockApi, type RecordedRequest, type RouteHandler } from '../../test/api'
import { renderRoutes } from '../../test/render'
import type { ReportSummary, ReportSummaryParams } from '../../types/api'
import { PRINT_CHART_WIDTH, PRINT_HALF_CHART_WIDTH } from './charts/useChartSize'
import { makeReport } from './testRoutes'

// Noon on 5 Oct 2026 in Amman; the browser runs in UTC.
const NOW = new Date('2026-10-05T09:00:00Z')

const report = makeReport({
  totals: { visits: 1284, unique_visitors: 930, checked_in: 1100, checked_out: 1080, no_show: 64, cancelled: 40, walk_ins: 120 },
  no_show_rate: 0.0561,
  avg_duration_seconds: 4380,
  visits_per_day: [
    { date: '2026-09-07', count: 30 },
    { date: '2026-09-15', count: 52 },
    { date: '2026-10-05', count: 12 },
  ],
  by_department: [
    { department_id: 'd-1', name: 'Finance', name_ar: null, count: 400 },
    { department_id: null, name: 'No department', name_ar: null, count: 84 },
    { department_id: 'd-2', name: 'Legal', name_ar: null, count: 800 },
  ],
  top_hosts: [
    { host_id: 'h-1', full_name: 'Omar Khalil', count: 321 },
    { host_id: 'h-2', full_name: 'Lina Haddad', count: 120 },
  ],
  check_ins_by_hour: [
    { hour: 9, count: 400 },
    { hour: 14, count: 250 },
  ],
})

function summaryRequests(requests: RecordedRequest[]) {
  return requests.filter((request) => request.path === '/reports/summary')
}

function lastQuery(requests: RecordedRequest[]) {
  return Object.fromEntries(summaryRequests(requests).at(-1)!.url.searchParams)
}

/** Answers with the report for the requested range (so the page's range and the data agree). */
const answer: RouteHandler = (request) => {
  const params = Object.fromEntries(request.url.searchParams) as ReportSummaryParams
  return jsonResponse({ ...report, date_from: params.date_from ?? report.date_from, date_to: params.date_to ?? report.date_to } satisfies ReportSummary)
}

function setup({ path = '/reports', summary = answer }: { path?: string; summary?: RouteHandler } = {}) {
  const api = mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['MANAGEMENT'])), 'GET /reports/summary': summary })
  return { ...api, ...renderRoutes(routes, { initialEntries: [path] }) }
}

/** The drawn widths of the report's charts (their SVG `width`), by chart name. */
function chartWidths() {
  return Object.fromEntries(
    screen
      .getAllByRole('group')
      .filter((element) => element.tagName === 'svg')
      .map((svg) => [svg.getAttribute('aria-label'), svg.getAttribute('width')]),
  )
}

/** The drawn heights of the report's charts (their SVG `height`), by chart name. */
function chartHeights() {
  return Object.fromEntries(
    screen
      .getAllByRole('group')
      .filter((element) => element.tagName === 'svg')
      .map((svg) => [svg.getAttribute('aria-label'), Number(svg.getAttribute('height'))]),
  )
}

/** The fill of a host's bar (the second rect of its track). */
function hostBarFill(row: HTMLElement) {
  return row.querySelector('svg[data-host-bar] rect:last-child')!
}

function figure(name: string) {
  return screen.getByRole('figure', { name })
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Reports', () => {
  it('reports the last 30 days by default, with the key figures and the period as facts under the title', async () => {
    const { requests } = setup()
    await screen.findByRole('figure', { name: 'Visits booked per day' })
    expect(lastQuery(requests)).toEqual({ date_from: '2026-09-06', date_to: '2026-10-05' })
    expect(screen.getByRole('combobox', { name: 'Period' })).toHaveValue('last-30')
    // The period read back in the app's format (data, not a sentence), the dates beside the preset.
    const header = screen.getByRole('heading', { level: 1, name: 'Reports' }).closest('header') as HTMLElement
    expect(header).toHaveTextContent('Sun, 6 Sep 2026 – Mon, 5 Oct 2026')
    expect(header).toHaveTextContent('30 days')
    expect(screen.getByRole('group', { name: 'Dates' })).toContainElement(screen.getByLabelText('From'))

    const summary = within(screen.getByRole('region', { name: 'Summary' }))
    // Booked, not attended: the dark tile says where the visits booked ended, adding up to them.
    const booked = summary.getByText('Visits booked').closest('div.rounded-card') as HTMLElement
    expect(booked).toHaveTextContent('1,284')
    expect(booked.className).toContain('bg-emphasis')
    const outcomes = within(booked).getByRole('list', { name: 'Visits booked by outcome' })
    expect(within(outcomes).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Arrived1,100',
      'No-show64',
      'Cancelled40',
      'Still expected80',
    ])
    expect(booked.querySelectorAll('[data-stat-meter] > span')).toHaveLength(4)
    expect(summary.getByText('Unique visitors').closest('div')).toHaveTextContent('930')
    expect(summary.getByText('Unique visitors').closest('div')).toHaveTextContent('1.2 visits per visitor')
    expect(summary.getByText('Checked in').closest('div')).toHaveTextContent('1,100')
    expect(summary.getByText('Checked in').closest('div')).toHaveTextContent('1,080 checked out120 walk-ins')
    const noShows = summary.getByText('No-show rate').closest('div') as HTMLElement
    expect(noShows).toHaveTextContent('5.6%')
    expect(noShows).toHaveTextContent('64 no-shows')
    // The rate's share as a meter: the no-shows in the attention yellow, the rest of its base muted.
    expect([...noShows.querySelectorAll('[data-stat-meter] > span')].map((segment) => segment.className)).toEqual([
      expect.stringContaining('bg-attention'),
      expect.stringContaining('bg-chart-muted'),
    ])
    expect(summary.getByText('Average duration').closest('div')).toHaveTextContent('1h 13m')
  })

  it('leaves out every explanatory note: no hints, explanations or time-zone sentences, each chart’s summary for assistive technology only', async () => {
    setup()
    const daily = await screen.findByRole('figure', { name: 'Visits booked per day' })
    for (const note of [/Point at or tab/, /counts every visit/, /People who came/, /Without corrected/, /Days and hours follow/, /ten hosts/]) {
      expect(screen.queryByText(note)).toBeNull()
    }
    // The time zone is named on paper only, by the printed sheet's "Generated …" line.
    expect(screen.queryAllByText(/Amman time/).filter((element) => !element.closest('header[aria-hidden="true"]'))).toEqual([])
    // The summary is the figure's description, never shown.
    const summaryId = daily.getAttribute('aria-describedby')!
    expect(document.getElementById(summaryId)).toHaveClass('sr-only')
    // Each chart says its one headline figure instead: the daily average, the busiest hour.
    expect(daily).toHaveTextContent('Daily average3.1')
    expect(figure('Check-ins by hour')).toHaveTextContent('Busiest hour09:00')
  })

  it('draws today as still under way and never calls it the busiest day: its count includes visitors still expected', async () => {
    setup({
      summary: () =>
        jsonResponse(
          makeReport({
            totals: { visits: 15, unique_visitors: 15, checked_in: 15, checked_out: 10, no_show: 0, cancelled: 0, walk_ins: 0 },
            visits_per_day: [
              { date: '2026-09-15', count: 3 },
              { date: '2026-10-05', count: 12 },
            ],
          }),
        ),
    })
    await screen.findByRole('figure', { name: 'Visits booked per day' })
    const daily = figure('Visits booked per day')
    expect(daily).toHaveAccessibleDescription('15 visits over 30 days. The busiest full day was Tue, 15 Sep 2026, with 3 visits. Today so far: 12 visits.')
    const today = within(daily).getAllByRole('img').at(-1)!
    expect(today).toHaveAccessibleName('Mon, 5 Oct 2026 (today, so far): 12 visits')
    // An in-progress mark (texture, not colour alone) named by the legend; the direct label marks the busiest full day.
    expect(daily.querySelectorAll('path[fill^="url(#"]')).toHaveLength(1)
    expect(within(daily).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Full days', 'Today, so far'])
    expect(within(daily).getAllByRole('listitem')[1]!.querySelector('rect[fill^="url(#"]')).not.toBeNull()
    expect(within(daily).getByText('3', { selector: 'text' })).toBeInTheDocument()
    expect(within(daily).queryByText('12', { selector: 'text' })).toBeNull()
  })

  it('draws one mark per day, with days without visits as 0, each readable by keyboard and in a table', async () => {
    const { user } = setup()
    await screen.findByRole('figure', { name: 'Visits booked per day' })
    const daily = figure('Visits booked per day')
    expect(daily).toHaveAccessibleDescription('94 visits over 30 days. The busiest full day was Tue, 15 Sep 2026, with 52 visits. Today so far: 12 visits.')

    const marks = within(daily).getAllByRole('img')
    expect(marks).toHaveLength(30)
    expect(marks[0]).toHaveAccessibleName('Sun, 6 Sep 2026: 0 visits')
    expect(marks[1]).toHaveAccessibleName('Mon, 7 Sep 2026: 30 visits')
    // One Tab stop per chart: the busiest day.
    expect(marks.filter((mark) => mark.getAttribute('tabindex') === '0')).toEqual([marks[9]])

    marks[9]!.focus()
    await user.keyboard('{ArrowRight}')
    expect(marks[10]).toHaveFocus()
    // The readout above the plot shows the value first, then the day.
    const readout = daily.querySelector('p[aria-hidden="true"]')!
    expect(readout).toHaveTextContent('0 visitsWed, 16 Sep 2026')
    await user.keyboard('{End}')
    expect(marks[29]).toHaveFocus()
    expect(readout).toHaveTextContent('12 visitsMon, 5 Oct 2026 (today, so far)')

    await user.hover(marks[1]!)
    expect(readout).toHaveTextContent('30 visitsMon, 7 Sep 2026')

    const table = within(daily).getByRole('table', { name: 'Visits booked per day' })
    expect(table.parentElement).toHaveClass('sr-only')
    expect(within(table).getAllByRole('row')).toHaveLength(31)
    await user.click(within(daily).getByRole('button', { name: 'Show table' }))
    expect(table.parentElement).not.toHaveClass('sr-only')
    expect(within(daily).getByRole('button', { name: 'Hide table' })).toBeInTheDocument()
  })

  it('buckets check-ins into the 24 hours of the company’s day', async () => {
    setup()
    await screen.findByRole('figure', { name: 'Check-ins by hour' })
    const hourly = figure('Check-ins by hour')
    const marks = within(hourly).getAllByRole('img')
    expect(marks).toHaveLength(24)
    expect(marks[0]).toHaveAccessibleName('00:00–\u206000:59: 0 check-ins')
    expect(marks[9]).toHaveAccessibleName('09:00–\u206009:59: 400 check-ins')
    expect(marks[23]).toHaveAccessibleName('23:00–\u206023:59: 0 check-ins')
    expect(hourly).toHaveAccessibleDescription('650 check-ins by hour of the day. Busiest hour: 09:00–\u206009:59.')
  })

  it('ranks departments and hosts', async () => {
    setup()
    await screen.findByRole('figure', { name: 'Visits by department' })
    const departments = figure('Visits by department')
    expect(within(departments).getAllByRole('img').map((mark) => mark.getAttribute('aria-label'))).toEqual([
      'Legal: 800 visits',
      'Finance: 400 visits',
      'No department: 84 visits',
    ])
    const hosts = screen.getByRole('table', { name: 'Top hosts' })
    const [first] = within(hosts).getAllByRole('row').slice(1)
    // The avatar is decorative: the row reads "1, Omar Khalil, 321, 25.0%".
    expect(within(first!).getByRole('rowheader')).toHaveAccessibleName('Omar Khalil')
    expect(within(first!).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['1', '321', '25.0%'])
  })

  it('changes the period from a preset or custom dates, and refuses more than 366 days', async () => {
    const { requests, router, user } = setup()
    await screen.findByRole('figure', { name: 'Visits booked per day' })

    await user.selectOptions(screen.getByRole('combobox', { name: 'Period' }), 'last-7')
    await waitFor(() => expect(lastQuery(requests)).toEqual({ date_from: '2026-09-29', date_to: '2026-10-05' }))
    expect(router.state.location.search).toBe('?from=2026-09-29&to=2026-10-05')

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } })
    await waitFor(() => expect(lastQuery(requests)).toEqual({ date_from: '2026-08-01', date_to: '2026-10-05' }))
    expect(screen.getByRole('combobox', { name: 'Period' })).toHaveValue('custom')

    const before = summaryRequests(requests).length
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2025-01-01' } })
    expect(screen.getByLabelText('To')).toHaveAccessibleDescription(expect.stringContaining('Choose a range of at most 366 days.'))
    expect(summaryRequests(requests)).toHaveLength(before)
    expect(screen.getByLabelText('From')).toHaveValue('2025-01-01')
  })

  it('draws a long range as a line', async () => {
    setup({ path: '/reports?from=2026-01-01&to=2026-10-05' })
    await screen.findByRole('figure', { name: 'Visits booked per day' })
    const daily = figure('Visits booked per day')
    expect(within(daily).getAllByRole('img')).toHaveLength(278)
    expect(daily.querySelector('path.stroke-chart-1')).not.toBeNull()
  })

  it('prints two pages: a header that says what the sheet covers, five tiles in a row, the charts sized for the paper', async () => {
    setup()
    await screen.findByRole('figure', { name: 'Visits booked per day' })

    // Paper only, like the evacuation list's header; the screen's own header does not print.
    const header = document.querySelector('header[aria-hidden="true"]') as HTMLElement
    expect(header.className).toContain('print:block')
    expect(header).toHaveTextContent('Acme Holdings')
    expect(header).toHaveTextContent('Visitor report')
    expect(header).toHaveTextContent('Sun, 6 Sep 2026 to Mon, 5 Oct 2026 (30 days).')
    expect(header).not.toHaveTextContent('Days and hours follow')
    expect(header).toHaveTextContent('Generated Mon, 5 Oct 2026 at 12:00:00, Amman time (UTC+3). Printed by Lina Haddad.')
    expect(screen.getByRole('heading', { level: 1, name: 'Reports' }).closest('.print\\:hidden')).not.toBeNull()
    const booked = within(screen.getByRole('region', { name: 'Summary' })).getByText('Visits booked').closest('div.rounded-card') as HTMLElement
    const tiles = booked.parentElement as HTMLElement
    expect(tiles.className).toContain('print:grid-cols-5')
    // The dark tile spans two rows on screen, one cell on paper, where its outcomes are one line (the meter is screen only).
    expect(booked.className).toContain('xl:row-span-2')
    expect(booked.className).toContain('print:row-span-1')
    const paperOutcomes = booked.querySelector('.print\\:inline') as HTMLElement
    expect(paperOutcomes).toHaveClass('hidden')
    expect(paperOutcomes).toHaveTextContent('Arrived 1,100 · No-show 64 · Cancelled 40 · Still expected 80')
    // Each label keeps its count on its line.
    expect([...paperOutcomes.querySelectorAll('.whitespace-nowrap')].map((pair) => pair.textContent)).toEqual([
      'Arrived 1,100',
      'No-show 64',
      'Cancelled 40',
      'Still expected 80',
    ])

    // The department and hour charts stand side by side on paper, so the top hosts follow on page 2.
    const pair = figure('Visits by department').parentElement as HTMLElement
    expect(pair).toBe(figure('Check-ins by hour').parentElement)
    expect(pair.className).toContain('print:grid-cols-2')

    // The browser lays the page out for paper right after `beforeprint`: the charts redraw first,
    // the daily one across the paper, the pair at half its width, all of them shorter.
    const screenWidths = chartWidths()
    const screenHeights = chartHeights()
    act(() => {
      window.dispatchEvent(new Event('beforeprint'))
    })
    expect(chartWidths()).toEqual({
      'Visits booked per day': String(PRINT_CHART_WIDTH),
      'Visits by department': String(PRINT_HALF_CHART_WIDTH),
      'Check-ins by hour': String(PRINT_HALF_CHART_WIDTH),
    })
    const printHeights = chartHeights()
    expect(printHeights['Visits booked per day']).toBeLessThan(screenHeights['Visits booked per day']!)
    expect(printHeights['Check-ins by hour']).toBeLessThan(screenHeights['Check-ins by hour']!)
    // Three departments, 34 px a row on paper (labels above the bars at half width).
    expect(printHeights['Visits by department']).toBe(3 * 34 + 4)
    act(() => {
      window.dispatchEvent(new Event('afterprint'))
    })
    expect(chartWidths()).toEqual(screenWidths)
    expect(chartHeights()).toEqual(screenHeights)
  })

  it('lets the top hosts table fill its card, with each host’s visits as a bar beside the count', async () => {
    setup()
    const hosts = await screen.findByRole('table', { name: 'Top hosts' })
    expect(hosts.className).not.toMatch(/max-w-/)
    const [first, second] = within(hosts).getAllByRole('row').slice(1)
    // The busiest host's bar fills its track; the next is as long as its share of it (120 of 321).
    expect(hostBarFill(first!)).toHaveAttribute('width', '100%')
    expect(hostBarFill(second!).getAttribute('width')).toBe(`${(120 / 321) * 100}%`)
    // Decorative, as the avatars are: the row reads its rank, name, count and share only.
    expect(first!.querySelector('svg[data-host-bar]')).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows an empty state for a period without visits', async () => {
    setup({ summary: () => jsonResponse(makeReport()) })
    const empty = await screen.findByRole('heading', { name: 'No visits in this period' })
    // A title and an icon, no sentence under it.
    expect(empty.parentElement!.querySelector('p')).toBeNull()
    expect(screen.queryByRole('figure')).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Summary' })).getByText('No-show rate').closest('div')).toHaveTextContent('—')
    // No outcomes to show: the dark tile is one row tall and the five tiles share a row from xl, so a
    // lone 0 is not the screen's heaviest block (review).
    const booked = within(screen.getByRole('region', { name: 'Summary' })).getByText('Visits booked').closest('div.rounded-card') as HTMLElement
    expect(booked).toHaveTextContent('0')
    expect(booked.className).not.toContain('xl:row-span-2')
    expect(booked.querySelector('.xl\\:text-\\[4\\.5rem\\]')).toBeNull()
    const tiles = booked.parentElement as HTMLElement
    expect(tiles).toHaveAttribute('data-empty-period')
    expect(tiles.className).toContain('xl:grid-cols-5')
  })
})

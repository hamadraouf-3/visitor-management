import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeStream, fakeTrack, mediaError } from '../../scanner/testing/fakeCamera'
import { errorResponse, jsonResponse } from '../../test/api'
import { FINANCE, LEGAL, makeHost, makeVisitor, VISITOR_ID } from '../../test/fixtures'
import { RECENT_CHECK_IN_MS } from './scanOutcome'
import { i18n } from '../../i18n'
import {
  checkedOutVisit,
  insideScan,
  insideVisit,
  PASS_TOKEN,
  PASS_URL,
  readyScan,
  RECEPTION_NOW,
  RECEPTIONIST,
  receptionVisit,
  VISIT_ID,
} from './testing/receptionFixtures'
import { buttonClassName } from '../../components/ui/buttonStyles'
import { renderReception, requestsTo, stubCoarsePointer } from './testing/renderReception'
import { UNRECOGNISED_QR_PLACEHOLDER } from './useScanStation'

const NOW = RECEPTION_NOW.getTime()
const CHECK_IN = `/visits/${VISIT_ID}/check-in`
const CHECK_OUT = `/visits/${VISIT_ID}/check-out`
const SCANNING = /Point the camera at the visitor/

function resultPanel(): HTMLElement {
  return screen.getByRole('region', { name: 'Scan result' })
}

/** The result's verdict band: its icon and its title (and, for a failed check, the error under it). */
function verdictBand(panel: HTMLElement = resultPanel()): HTMLElement | null {
  return panel.querySelector<HTMLElement>('[data-tone]')
}

function passField(): HTMLElement {
  return screen.getByLabelText('Scan or paste a pass')
}

/**
 * The result's action buttons appear in this order in the DOM, which is also the visual and Tab
 * order: no reversed flex row or column anywhere in the panel.
 */
function expectActionOrder(names: string[]) {
  const panel = resultPanel()
  const shown = within(panel)
    .getAllByRole('button')
    .map((button) => button.textContent?.trim() ?? '')
    .filter((name) => names.includes(name))
  expect(shown).toEqual(names)
  expect(panel.querySelector('[class*="-reverse"]')).toBeNull()
}

/**
 * Which group of the result's action row holds the button: `start` (beside "Scan next", the
 * left or top) or `end` (where Check in sits: the right, or the bottom on phones).
 */
function actionGroup(button: HTMLElement): string | null {
  return button.closest<HTMLElement>('[data-action-group]')?.dataset.actionGroup ?? null
}

/** The large confirmation of the success state ("Checked in" / "Checked out"). */
function findSuccess(text: 'Checked in' | 'Checked out') {
  return within(resultPanel()).findByText(text, { selector: 'p' })
}

type User = ReturnType<typeof renderReception>['user']

/** Pastes a pass into the field and presses Enter (as a handheld scanner would, but faster to simulate). */
async function enterPass(user: User, value: string, label = 'Scan or paste a pass') {
  const field = await screen.findByLabelText(label)
  await user.click(field)
  await user.paste(value)
  await user.keyboard('{Enter}')
}

/** Real time passes (only the clock is fake): lets the decode loop run a few frames. */
async function wait(ms: number) {
  await act(() => new Promise((resolve) => setTimeout(resolve, ms)))
}

beforeEach(() => {
  vi.useFakeTimers({ now: RECEPTION_NOW, toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('reception scanner: camera', () => {
  it('starts the camera on its own, sends one scan per detection and pauses decoding while the result shows', async () => {
    const { scene, requests, camera, user } = renderReception({ routes: { 'POST /reception/scan': () => jsonResponse(readyScan()) } })
    await screen.findByText(SCANNING)
    expect(camera.getUserMedia).toHaveBeenCalledOnce()

    scene.show(PASS_URL)
    await screen.findByRole('heading', { level: 3, name: 'Élodie Martin' })
    // The recognised pass is sent as its bare token.
    expect(requestsTo(requests, 'POST', '/reception/scan').map((request) => request.body)).toEqual([{ token: PASS_TOKEN }])
    expect(screen.getByText('Scanning paused')).toBeInTheDocument()

    // The code is still in front of the camera: nothing more while the result is shown...
    await wait(600)
    expect(requestsTo(requests, 'POST', '/reception/scan')).toHaveLength(1)

    // ...nor after "Scan next" while it stays in view (the same token is ignored for 5 s).
    await user.click(screen.getByRole('button', { name: 'Scan next' }))
    await screen.findByText('Ready to scan')
    await wait(600)
    expect(requestsTo(requests, 'POST', '/reception/scan')).toHaveLength(1)

    // Away for 5 s, then held up again: a new scan.
    scene.show(null)
    await wait(300)
    vi.setSystemTime(NOW + 5_100)
    scene.show(PASS_URL)
    await waitFor(() => expect(requestsTo(requests, 'POST', '/reception/scan')).toHaveLength(2))
  })

  it('shows the visit for an ID check and puts focus on the one primary action, Check in', async () => {
    const { scene } = renderReception({ routes: { 'POST /reception/scan': () => jsonResponse(readyScan()) } })
    await screen.findByText(SCANNING)
    scene.show(PASS_URL)

    const checkIn = await screen.findByRole('button', { name: 'Check in' })
    await waitFor(() => expect(checkIn).toHaveFocus())
    const panel = resultPanel()
    // The verdict opens the result, in the success tone; the visit's own status badge is left out.
    const verdict = within(panel).getByText('Valid pass – ready to check in')
    expect(verdict.closest('[data-tone]')).toHaveAttribute('data-tone', 'success')
    expect(verdict.compareDocumentPosition(within(panel).getByRole('heading', { name: 'Élodie Martin' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(panel).queryByText('Scheduled', { selector: 'span' })).toBeNull()
    expect(panel).toHaveTextContent('Verify ID: Élodie Martin')
    // Direction C: the visitor's company under the name, not again among the facts.
    expect(within(panel).getByRole('heading', { name: 'Élodie Martin' }).nextElementSibling).toHaveTextContent(/^Orbit Labs$/)
    expect(within(panel).queryByText('Company')).toBeNull()
    expect(panel).toHaveTextContent('DepartmentFinance')
    expect(panel).toHaveTextContent('PurposeQuarterly review')
    expect(panel).toHaveTextContent('ScheduledToday, 09:00–\u206010:00')
    expect(within(panel).getByRole('link', { name: 'Call Omar Khalil: +962 79 000 0077' })).toHaveAttribute('href', 'tel:+962790000077')
    expect(within(panel).getByRole('status')).toHaveTextContent('Ready to check in Élodie Martin. Verify ID.')
    // Check in comes after the visit's facts, last in the one action row every result uses.
    expect(within(panel).getByText('Purpose').compareDocumentPosition(checkIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expectActionOrder(['Scan next', 'Check in'])
    expect(actionGroup(checkIn)).toBe('end')
  })

  it('says an early visitor is early, by how much, as information rather than a warning', async () => {
    const early = receptionVisit({ scheduled_start: '2026-10-06T06:20:00Z', scheduled_end: '2026-10-06T07:50:00Z' })
    const { user } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'POST /reception/scan': () =>
          jsonResponse(readyScan(early, [{ code: 'OUTSIDE_SCHEDULED_TIME', message: 'Visitor is outside the scheduled visit time.' }])),
      },
    })
    await enterPass(user, PASS_URL)

    const notice = await within(resultPanel()).findByText('Early: scheduled 09:20–\u206010:50 (starts in 10m)')
    expect(notice.closest('[data-tone]')).toHaveAttribute('data-tone', 'info')
    expect(resultPanel()).not.toHaveTextContent('Visitor is outside the scheduled visit time.')
  })

  it('sends a placeholder, not the content, for a camera QR code that is not a pass', async () => {
    const { scene, requests } = renderReception({
      routes: { 'POST /reception/scan': () => errorResponse(404, 'PASS_INVALID', 'Invalid visitor pass.') },
    })
    await screen.findByText(SCANNING)
    // A Wi-Fi code in view, password included: it must not leave the device.
    scene.show('WIFI:S:Office;T:WPA;P:correct-horse-battery;;')

    expect(await screen.findByText('Invalid visitor pass.', { selector: '[data-tone] p' })).toBeInTheDocument()
    expect(requestsTo(requests, 'POST', '/reception/scan').map((request) => request.body)).toEqual([{ token: UNRECOGNISED_QR_PLACEHOLDER }])
    expect(JSON.stringify(requests.map((request) => request.body))).not.toContain('correct-horse-battery')
  })

  it('checks in with the scanned pass, shows the success state, returns focus to the pass field and resumes scanning', async () => {
    const { scene, requests, user } = renderReception({
      routes: {
        'POST /reception/scan': () => jsonResponse(readyScan()),
        [`POST ${CHECK_IN}`]: () => jsonResponse(insideVisit()),
      },
    })
    await screen.findByText(SCANNING)
    scene.show(PASS_URL)
    await user.click(await screen.findByRole('button', { name: 'Check in' }))

    expect(await findSuccess('Checked in')).toBeInTheDocument()
    expect(requestsTo(requests, 'POST', CHECK_IN).map((request) => request.body)).toEqual([{ method: 'QR', pass_token: PASS_TOKEN }])
    expect(within(resultPanel()).getByRole('status')).toHaveTextContent('Élodie Martin checked in.')
    await waitFor(() => expect(passField()).toHaveFocus())
    // Lists and counts are refreshed after the check-in.
    await waitFor(() => expect(requestsTo(requests, 'GET', '/reception/today').length).toBeGreaterThan(1))

    // About 1.5 s later the scanner is ready again, without a tap; the same pass is not re-sent.
    await screen.findByText('Ready to scan', {}, { timeout: 3_000 })
    expect(screen.getByText(SCANNING)).toBeInTheDocument()
    expect(requestsTo(requests, 'POST', '/reception/scan')).toHaveLength(1)
  })

  it('stops the camera when the screen is left', async () => {
    const { camera, unmount } = renderReception()
    await screen.findByText(SCANNING)
    unmount()
    expect(camera.tracks[0]?.stop).toHaveBeenCalledOnce()
  })

  it('explains a camera that is busy and starts it on "Try again"', async () => {
    let calls = 0
    renderReception({
      camera: {
        getUserMedia: () => {
          calls += 1
          return calls === 1 ? Promise.reject(mediaError('NotReadableError')) : Promise.resolve(fakeStream(fakeTrack()))
        },
      },
    })

    expect(await screen.findByText('The camera is in use')).toBeInTheDocument()
    expect(screen.getByText(/Another app or browser tab may be using the camera/, { selector: 'p:not(.sr-only)' })).toBeInTheDocument()
    screen.getByRole('button', { name: 'Try again' }).click()
    expect(await screen.findByText(SCANNING)).toBeInTheDocument()
  })

  it('waits for "Start camera" until the browser has granted access', async () => {
    const { camera, user } = renderReception({ camera: { permission: 'prompt' } })
    await user.click(await screen.findByRole('button', { name: 'Start camera' }))
    expect(await screen.findByText(SCANNING)).toBeInTheDocument()
    expect(camera.getUserMedia).toHaveBeenCalledOnce()
  })

  it('explains a blocked camera and keeps the pass field working', async () => {
    renderReception({ camera: { permission: 'denied' } })
    expect(await screen.findByText('Camera access is blocked')).toBeInTheDocument()
    expect(passField()).toBeEnabled()
  })
})

describe('reception scanner: handheld scanner and paste input', () => {
  it('takes focus on a fine-pointer device, sends what was typed and Enter checks the visitor in', async () => {
    const { requests, user } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'POST /reception/scan': () => jsonResponse(readyScan()),
        [`POST ${CHECK_IN}`]: () => jsonResponse(insideVisit()),
      },
    })
    const field = await screen.findByLabelText('Scan or paste a pass')
    await waitFor(() => expect(field).toHaveFocus())

    await user.type(field, `${PASS_URL}{Enter}`)
    const checkIn = await screen.findByRole('button', { name: 'Check in' })
    await waitFor(() => expect(checkIn).toHaveFocus())
    expect(field).toHaveValue('')

    await user.keyboard('{Enter}')
    await findSuccess('Checked in')
    expect(requestsTo(requests, 'POST', CHECK_IN)).toHaveLength(1)
    await waitFor(() => expect(field).toHaveFocus())
  })

  it('sends input that is not a pass to the server, which answers and records PASS_INVALID', async () => {
    const { requests, user } = renderReception({
      camera: { permission: 'prompt' },
      routes: { 'POST /reception/scan': () => errorResponse(404, 'PASS_INVALID', 'Invalid visitor pass.') },
    })
    await user.type(await screen.findByLabelText('Scan or paste a pass'), 'hello world{Enter}')

    // The server's message once, as the verdict; no sentence of advice under it (decision 3): the actions say it.
    const title = await screen.findByText('Invalid visitor pass.', { selector: '[data-tone] p' })
    expect(title).toHaveClass('font-bold')
    expect(title.nextElementSibling).toBeNull()
    expect(requestsTo(requests, 'POST', '/reception/scan').map((request) => request.body)).toEqual([{ token: 'hello world' }])
    const panel = resultPanel()
    expect(title.closest('[data-tone]')?.textContent?.match(/Invalid visitor pass/g)).toHaveLength(1)
    expect(within(panel).getByRole('button', { name: 'Register walk-in' })).toBeInTheDocument()
    expect(within(panel).getByRole('status')).toHaveTextContent(/^Invalid visitor pass\.$/)
  })

  it('ignores Enter in the empty field when no result is shown', async () => {
    const { requests, user } = renderReception({ camera: { permission: 'prompt' } })
    const field = await screen.findByLabelText('Scan or paste a pass')
    await user.click(field)
    await user.keyboard('{Enter}')
    expect(requestsTo(requests, 'POST', '/reception/scan')).toHaveLength(0)
  })

  it('Enter in the empty pass field triggers the shown result’s primary action', async () => {
    const { requests, user } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'POST /reception/scan': () => jsonResponse(readyScan()),
        [`POST ${CHECK_IN}`]: () => jsonResponse(insideVisit()),
      },
    })
    const field = await screen.findByLabelText('Scan or paste a pass')
    await enterPass(user, PASS_TOKEN)
    await screen.findByRole('button', { name: 'Check in' })

    await user.click(field)
    await user.keyboard('{Enter}')
    await findSuccess('Checked in')
    expect(requestsTo(requests, 'POST', CHECK_IN)).toHaveLength(1)
  })

  it('sends keys typed while a result’s button has focus to the pass field (the next code is not lost)', async () => {
    const { user } = renderReception({ camera: { permission: 'prompt' }, routes: { 'POST /reception/scan': () => jsonResponse(readyScan()) } })
    const field = await screen.findByLabelText('Scan or paste a pass')
    await enterPass(user, PASS_TOKEN)
    const checkIn = await screen.findByRole('button', { name: 'Check in' })
    await waitFor(() => expect(checkIn).toHaveFocus())

    await user.keyboard('h')
    expect(field).toHaveFocus()
  })

  it('lets Tab leave the pass field and its button instead of taking focus back (no keyboard trap)', async () => {
    const { user } = renderReception({ camera: { permission: 'prompt' } })
    await waitFor(() => expect(passField()).toHaveFocus())

    await user.tab()
    expect(screen.getByRole('button', { name: 'Check pass' })).toHaveFocus()
    // Past the last control focus rests on the document (a kiosk without browser controls)...
    await user.tab()
    await wait(50)
    // ...and is not pulled back into the field, so the next Tab continues at the top of the page.
    expect(passField()).not.toHaveFocus()
  })

  it('does not take focus back when it moved to the browser’s own controls', async () => {
    renderReception({ camera: { permission: 'prompt' } })
    await waitFor(() => expect(passField()).toHaveFocus())

    // Tab past the page's last control, or a click in the address bar: the page loses focus.
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    act(() => passField().blur())
    await wait(50)
    expect(passField()).not.toHaveFocus()
  })

  it('leaves a result with Escape', async () => {
    const { user } = renderReception({ camera: { permission: 'prompt' }, routes: { 'POST /reception/scan': () => jsonResponse(readyScan()) } })
    await enterPass(user, PASS_TOKEN)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check in' })).toHaveFocus())

    await user.keyboard('{Escape}')
    expect(await screen.findByText('Ready to scan')).toBeInTheDocument()
    await waitFor(() => expect(passField()).toHaveFocus())
  })
})

describe('reception scanner: touch screens (pointer: coarse)', () => {
  it('collapses the pass field behind "Enter or paste pass" and never focuses it on its own', async () => {
    stubCoarsePointer()
    const { user } = renderReception({ camera: { permission: 'prompt' } })
    const toggle = await screen.findByRole('button', { name: 'Enter or paste pass' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(passField()).not.toBeVisible()
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(passField()).not.toHaveFocus()

    await user.click(toggle)
    expect(passField()).toBeVisible()
    expect(passField()).toHaveFocus()
    expect(passField()).toHaveAttribute('inputmode', 'url')
    // Once open, the field has one control to close it, in its own row (not the button above it as well).
    expect(screen.queryByRole('button', { name: 'Enter or paste pass' })).toBeNull()
    const hide = screen.getByRole('button', { name: 'Hide pass field' })
    expect(hide).toHaveAttribute('aria-expanded', 'true')

    await user.click(hide)
    expect(passField()).not.toBeVisible()
    expect(screen.getByRole('button', { name: 'Enter or paste pass' })).toHaveFocus()
  })

  it('leaves focus where it is after a full page load, until a pass was handled (no ring on "Enter or paste pass")', async () => {
    stubCoarsePointer()
    const { scene, user } = renderReception({ routes: { 'POST /reception/scan': () => jsonResponse(readyScan()) } })
    const toggle = await screen.findByRole('button', { name: 'Enter or paste pass' })
    await screen.findByText(SCANNING)
    await act(() => new Promise((resolve) => setTimeout(resolve, 150)))
    // A kiosk reload or a bookmark: focus stays on the page, so a screen reader starts at the top.
    expect(toggle).not.toHaveFocus()
    expect(document.activeElement).toBe(document.body)

    // Once a pass was handled, leaving its result puts focus on the pass entry again.
    scene.show(PASS_URL)
    await user.click(await screen.findByRole('button', { name: 'Scan next' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enter or paste pass' })).toHaveFocus())
  })

  it('makes "Enter or paste pass" the way to scan when the camera is blocked, and says so', async () => {
    stubCoarsePointer()
    renderReception({ camera: { permission: 'denied' } })
    expect(await screen.findByText('Camera access is blocked')).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'Enter or paste pass' })
    expect(toggle.className).toBe(buttonClassName({ variant: 'primary', size: 'lg', className: 'w-full' }))
    // Still closed: no on-screen keyboard opens by itself.
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // The camera panel says why; the result panel adds no note.
    expect(resultPanel()).toHaveTextContent(/^Scan resultReady to scan/)
  })

  it('keeps "Enter or paste pass" outlined while the camera works', async () => {
    stubCoarsePointer()
    renderReception()
    await screen.findByText(SCANNING)
    const toggle = screen.getByRole('button', { name: 'Enter or paste pass' })
    expect(toggle.className).toBe(buttonClassName({ variant: 'secondary', size: 'lg', className: 'w-full' }))
    expect(resultPanel()).toHaveTextContent(/^Scan resultReady to scan/)
  })

  it('opens the field when a hardware keyboard or handheld scanner types', async () => {
    stubCoarsePointer()
    const { user } = renderReception({ camera: { permission: 'prompt' } })
    await screen.findByRole('button', { name: 'Enter or paste pass' })

    await user.keyboard('X')
    expect(passField()).toBeVisible()
    expect(passField()).toHaveFocus()
  })

  it('after an action returns focus to the "Enter or paste pass" button, so no keyboard opens', async () => {
    stubCoarsePointer()
    const { scene, user } = renderReception({
      routes: {
        'POST /reception/scan': () => jsonResponse(readyScan()),
        [`POST ${CHECK_IN}`]: () => jsonResponse(insideVisit()),
      },
    })
    await screen.findByText(SCANNING)
    scene.show(PASS_URL)
    await user.click(await screen.findByRole('button', { name: 'Check in' }))

    await findSuccess('Checked in')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enter or paste pass' })).toHaveFocus())
  })
})

describe('reception scanner: the beep switch', () => {
  it('sits after the pass entry and the result, out of the way between the camera and the pass entry', async () => {
    renderReception({ camera: { permission: 'prompt' } })
    const beep = await screen.findByRole('checkbox', { name: 'Beep on check-in and check-out' })
    expect(beep).not.toBeChecked()
    const field = passField()
    expect(field.compareDocumentPosition(beep) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(resultPanel().compareDocumentPosition(beep) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('turns the success beep on and remembers it on the device', async () => {
    const { user } = renderReception({ camera: { permission: 'prompt' } })
    const beep = await screen.findByRole('checkbox', { name: 'Beep on check-in and check-out' })
    await user.click(beep)
    expect(beep).toBeChecked()
    expect(localStorage.getItem('vms.reception.successFeedback')).toBe('on')
  })
})

describe('reception scanner: visitor already inside', () => {
  it('flags an overdue visitor as every list does, next to the status, instead of the server’s sentence', async () => {
    const overdue = insideVisit({
      check_in_at: '2026-10-06T05:02:00Z',
      scheduled_start: '2026-10-06T05:00:00Z',
      scheduled_end: '2026-10-06T06:05:00Z',
      is_overdue: true,
    })
    const { user } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'POST /reception/scan': () =>
          jsonResponse(insideScan(overdue, [{ code: 'OVERSTAYED', message: 'Visitor has stayed past the scheduled end time.' }])),
      },
    })
    await enterPass(user, PASS_URL)

    const flag = await within(resultPanel()).findByText('Overdue · due out 09:05')
    const status = within(resultPanel()).getByText('Checked in', { selector: 'span' })
    expect(flag.closest('p')).toBe(status.closest('p'))
    expect(resultPanel()).not.toHaveTextContent('Visitor has stayed past the scheduled end time.')
  })

  it('says the pass was already used, offers Check out in the outlined style, and checks out with the scanned pass', async () => {
    const { requests, user } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'POST /reception/scan': () => jsonResponse(insideScan()),
        [`POST ${CHECK_OUT}`]: () => jsonResponse(checkedOutVisit()),
      },
    })
    await enterPass(user, PASS_URL)

    const checkOut = await screen.findByRole('button', { name: 'Check out' })
    await waitFor(() => expect(checkOut).toHaveFocus())
    expect(screen.queryByRole('button', { name: 'Check in' })).toBeNull()
    // The outcome first: a pass presented again may have been forwarded (§12), so the ID cue is named.
    const headline = within(resultPanel()).getByText('Already checked in at 09:02 (8m ago)')
    expect(headline.compareDocumentPosition(within(resultPanel()).getByRole('heading', { name: 'Élodie Martin' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Outlined, not the solid primary style of Check in, and never in Check in's place (§10): beside
    // "Scan next", with the slot where Check in sits left empty.
    expect(checkOut.className).toContain('border-border-strong')
    expect(checkOut.className).not.toContain('bg-accent')
    expectActionOrder(['Scan next', 'Check out'])
    expect(actionGroup(checkOut)).toBe('start')
    expect(resultPanel().querySelector('[data-action-group="end"]')).toBeNull()
    expect(resultPanel()).toHaveTextContent('Checked in09:02 · 8m inside')

    await user.click(checkOut)
    expect(await findSuccess('Checked out')).toBeInTheDocument()
    expect(requestsTo(requests, 'POST', CHECK_OUT).map((request) => request.body)).toEqual([{ method: 'QR', pass_token: PASS_TOKEN }])
  })

  it('dates a check-in of an earlier day: the date in English, «يوم … الساعة …» in Arabic, never «الساعة» before a date (review)', async () => {
    // 21:48 on Mon 5 Oct in Amman; now is 09:10 on Tue 6 Oct.
    const yesterday = insideVisit({ check_in_at: '2026-10-05T18:48:00Z' })
    const { user } = renderReception({ camera: { permission: 'prompt' }, routes: { 'POST /reception/scan': () => jsonResponse(insideScan(yesterday)) } })
    await enterPass(user, PASS_URL)
    expect(await within(resultPanel()).findByText('Already checked in at Mon, 5 Oct 2026, 21:48 (11h 22m ago)')).toBeInTheDocument()
  })

  it('dates a check-in of an earlier day in Arabic with «يوم» and «الساعة» in their places', async () => {
    await i18n.changeLanguage('ar')
    const yesterday = insideVisit({ check_in_at: '2026-10-05T18:48:00Z' })
    const { user } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'GET /auth/me': () => jsonResponse({ ...RECEPTIONIST, user: { ...RECEPTIONIST.user, preferred_language: 'ar' } }),
        'POST /reception/scan': () => jsonResponse(insideScan(yesterday)),
      },
    })
    await enterPass(user, PASS_URL, 'امسح البطاقة أو الصقها')
    const panel = await screen.findByRole('region', { name: 'نتيجة المسح' })
    await waitFor(() => expect(panel).toHaveTextContent('سبق تسجيل الدخول يوم الاثنين، 5 تشرين الأول 2026 الساعة 21:48 (قبل 11 س 22 د)'))
    expect(panel).not.toHaveTextContent(/الساعة (?:الاثنين|الثلاثاء)/)
  })

  it('says «قبل أقل من دقيقة» in Arabic for a check-in under a minute ago, not «قبل < 1 د»', async () => {
    await i18n.changeLanguage('ar')
    const justNow = insideVisit({ check_in_at: new Date(NOW - 30_000).toISOString() })
    const { user } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'GET /auth/me': () => jsonResponse({ ...RECEPTIONIST, user: { ...RECEPTIONIST.user, preferred_language: 'ar' } }),
        'POST /reception/scan': () => jsonResponse(insideScan(justNow)),
      },
    })
    await enterPass(user, PASS_URL, 'امسح البطاقة أو الصقها')
    const panel = await screen.findByRole('region', { name: 'نتيجة المسح' })
    await waitFor(() => expect(panel).toHaveTextContent('سبق تسجيل الدخول الساعة 09:09 (قبل أقل من دقيقة)'))
    // The visit's facts say it in words too («منذ < 1 د في الداخل» before).
    expect(panel).toHaveTextContent('09:09 · منذ أقل من دقيقة في الداخل')
    expect(panel).not.toHaveTextContent('<')
    // The check-out confirmation's title (checked in under 5 minutes ago).
    await user.click(within(panel).getByRole('button', { name: 'تسجيل الخروج…' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent('سُجّل الدخول قبل أقل من دقيقة')
  })

  it('asks for confirmation when the check-in was less than 5 minutes ago, and Enter does not check out', async () => {
    const recent = insideVisit({ check_in_at: new Date(NOW - RECENT_CHECK_IN_MS + 3 * 60_000).toISOString() })
    const { requests, user } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'POST /reception/scan': () => jsonResponse(insideScan(recent)),
        [`POST ${CHECK_OUT}`]: () => jsonResponse(checkedOutVisit()),
      },
    })
    const field = await screen.findByLabelText('Scan or paste a pass')
    await enterPass(user, PASS_URL)

    const scanNext = await screen.findByRole('button', { name: 'Scan next' })
    await waitFor(() => expect(scanNext).toHaveFocus())
    expect(screen.queryByRole('button', { name: 'Check out' })).toBeNull()
    expect(resultPanel()).toHaveTextContent('Already checked in at 09:08 (2m ago)')

    await user.click(field)
    await user.keyboard('{Enter}')
    expect(requestsTo(requests, 'POST', CHECK_OUT)).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Check out…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Check out Élodie Martin?' })
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(within(dialog).getByRole('button', { name: 'Check out' }))

    expect(await findSuccess('Checked out')).toBeInTheDocument()
    expect(requestsTo(requests, 'POST', CHECK_OUT).map((request) => request.body)).toEqual([{ method: 'QR', pass_token: PASS_TOKEN }])
  })

  it('switches to the one-key Check out exactly when the check-in turns 5 minutes old, and Enter follows what is shown', async () => {
    // Checked in 4 min 59.8 s ago.
    const almost = insideVisit({ check_in_at: new Date(NOW - RECENT_CHECK_IN_MS + 200).toISOString() })
    const { requests, user } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'POST /reception/scan': () => jsonResponse(insideScan(almost)),
        [`POST ${CHECK_OUT}`]: () => jsonResponse(checkedOutVisit()),
      },
    })
    const field = await screen.findByLabelText('Scan or paste a pass')
    await enterPass(user, PASS_URL)
    expect(await screen.findByRole('button', { name: 'Check out…' })).toBeInTheDocument()
    await user.click(field)
    await user.keyboard('{Enter}')
    expect(requestsTo(requests, 'POST', CHECK_OUT)).toHaveLength(0)

    // The 5 minutes pass: the panel changes at that moment (not at its next 10 s refresh)...
    vi.setSystemTime(NOW + 300)
    expect(await screen.findByRole('button', { name: 'Check out' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check out…' })).toBeNull()
    // ...and Enter does what the panel now shows.
    await user.click(field)
    await user.keyboard('{Enter}')
    await waitFor(() => expect(requestsTo(requests, 'POST', CHECK_OUT)).toHaveLength(1))
  })

  it('still switches when the clock had not reached the 5 minutes as the timer for them fired', async () => {
    // A device's clock can stand behind the timer's (it was set back; in these tests it does not run at all).
    // The timer then waits for the rest instead of leaving the panel to its next 10 s refresh.
    const almost = insideVisit({ check_in_at: new Date(NOW - RECENT_CHECK_IN_MS + 200).toISOString() })
    const { user } = renderReception({ camera: { permission: 'prompt' }, routes: { 'POST /reception/scan': () => jsonResponse(insideScan(almost)) } })
    await screen.findByLabelText('Scan or paste a pass')
    await enterPass(user, PASS_URL)
    expect(await screen.findByRole('button', { name: 'Check out…' })).toBeInTheDocument()
    // The timer for the remaining 200 ms fires while the clock still says 4 min 59.8 s.
    await wait(450)
    expect(screen.getByRole('button', { name: 'Check out…' })).toBeInTheDocument()
    vi.setSystemTime(NOW + 300)
    expect(await screen.findByRole('button', { name: 'Check out' }, { timeout: 1_500 })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check out…' })).toBeNull()
  })
})

describe('reception scanner: refused passes', () => {
  it.each([
    [
      'a cancelled visit',
      () => errorResponse(409, 'VISIT_CANCELLED', 'This visit has been cancelled.', {
        visit: receptionVisit({ status: 'CANCELLED', cancelled_by: { id: 'u-yara', full_name: 'يارا حداد' } }),
        check_in_options: [],
      }),
      'أُلغيت الزيارة بواسطة يارا حداد',
      'أُلغيت هذه الزيارة.',
    ],
    [
      'an expired pass',
      () => errorResponse(410, 'PASS_EXPIRED', 'This visitor pass has expired.', {
        visit: receptionVisit({ status: 'NO_SHOW', no_show_at: '2026-10-06T08:01:00Z' }),
        check_in_options: ['OVERRIDE'],
      }),
      'انتهت صلاحية البطاقة الساعة 11:00',
      'انتهت صلاحية بطاقة الزيارة هذه.',
    ],
  ])('shows %s in Arabic as its title alone, not the same fact again under it (decision 3)', async (_case, refusal, title, restated) => {
    await i18n.changeLanguage('ar')
    const { user } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'GET /auth/me': () => jsonResponse({ ...RECEPTIONIST, user: { ...RECEPTIONIST.user, preferred_language: 'ar' } }),
        'POST /reception/scan': refusal,
      },
    })
    await enterPass(user, PASS_URL, 'امسح البطاقة أو الصقها')
    const panel = await screen.findByRole('region', { name: 'نتيجة المسح' })
    await waitFor(() => expect(verdictBand(panel)).toHaveTextContent(new RegExp(`^${title}$`)))
    expect(panel).not.toHaveTextContent(restated)
    // The live region says it once too.
    expect(within(panel).getByRole('status')).toHaveTextContent(new RegExp(`^${title}$`))
  })

  it('offers "Verify ID & check in" (MANUAL) for a replaced pass inside its window', async () => {
    const visit = receptionVisit({ pass: { status: 'REVOKED', revoke_reason: 'ROTATED' } })
    const { requests, user } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'POST /reception/scan': () =>
          errorResponse(
            410,
            'PASS_REVOKED',
            'This visitor pass has been replaced. Ask the visitor for their latest invitation, or verify their ID and check in manually.',
            { visit, check_in_options: ['MANUAL'] },
          ),
        [`POST ${CHECK_IN}`]: () => jsonResponse(insideVisit()),
      },
    })
    await enterPass(user, PASS_URL)

    // When the newer pass was issued, which the server's message does not say; the title alone
    // (the message restated it and gave advice the actions give: decision 3, no subtitles).
    await waitFor(() => expect(verdictBand()).toHaveTextContent(/^Pass replaced on Mon, 5 Oct 2026, 09:10$/))
    expect(resultPanel()).not.toHaveTextContent('This visitor pass has been replaced.')
    const manual = screen.getByRole('button', { name: 'Verify ID & check in' })
    await waitFor(() => expect(manual).toHaveFocus())
    await user.click(manual)

    await findSuccess('Checked in')
    expect(requestsTo(requests, 'POST', CHECK_IN).map((request) => request.body)).toEqual([{ method: 'MANUAL' }])
  })

  it('checks in an expired pass anyway (OVERRIDE) only with a reason, and shows the server’s refusal', async () => {
    let attempts = 0
    const { requests, user } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'POST /reception/scan': () =>
          errorResponse(410, 'PASS_EXPIRED', 'This visitor pass has expired.', {
            visit: receptionVisit({ status: 'NO_SHOW', no_show_at: '2026-10-06T08:01:00Z' }),
            check_in_options: ['OVERRIDE'],
          }),
        [`POST ${CHECK_IN}`]: () => {
          attempts += 1
          return attempts === 1
            ? errorResponse(409, 'OVERRIDE_NOT_ALLOWED', 'This visit cannot be checked in with an override.')
            : jsonResponse(insideVisit({ check_in_method: 'OVERRIDE', check_in_note: 'Train delayed' }))
        },
      },
    })
    await enterPass(user, PASS_URL)
    // The title alone: «انتهت صلاحية البطاقة الساعة 11:00» over «انتهت صلاحية بطاقة الزيارة هذه.» said it twice.
    await waitFor(() => expect(verdictBand()).toHaveTextContent(/^Pass expired at 11:00$/))
    expect(resultPanel()).not.toHaveTextContent('This visitor pass has expired.')

    await user.click(screen.getByRole('button', { name: 'Check in anyway…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Check in anyway' })
    // Why the pass cannot be used, and nothing more: the dialog shows the ID cue itself.
    expect(dialog).toHaveAccessibleDescription('This visitor pass has expired.')
    expect(dialog).toHaveTextContent('Verify ID: Élodie Martin')
    // Focus starts on the common reason that applies (late, for a no-show), not on the text field,
    // so a tablet's on-screen keyboard stays closed; the reason for an early arrival is not offered.
    expect(within(dialog).getByRole('button', { name: 'Arrived late – host confirmed' })).toHaveFocus()
    expect(within(dialog).queryByRole('button', { name: 'Arrived early – host confirmed' })).toBeNull()
    const reason = within(dialog).getByRole('textbox', { name: 'Reason' })

    await user.click(within(dialog).getByRole('button', { name: 'Check in anyway' }))
    expect(await within(dialog).findByText(/Choose a common reason, or enter why the visitor is checked in anyway/)).toBeInTheDocument()
    expect(requestsTo(requests, 'POST', CHECK_IN)).toHaveLength(0)

    await user.type(reason, 'Train delayed')
    await user.click(within(dialog).getByRole('button', { name: 'Check in anyway' }))
    expect(await within(dialog).findByText('This visit cannot be checked in with an override.')).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Check in anyway' }))
    expect(await findSuccess('Checked in')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(requestsTo(requests, 'POST', CHECK_IN).map((request) => request.body)).toEqual([
      { method: 'OVERRIDE', reason: 'Train delayed' },
      { method: 'OVERRIDE', reason: 'Train delayed' },
    ])
  })

  it('explains a completed visit and opens a walk-in pre-filled with the visitor, host, department and purpose', async () => {
    // The host's own department (Legal) differs from the one the visit was booked for (Finance).
    const omar = makeHost({ id: receptionVisit().host.id, full_name: 'Omar Khalil', phone: '+962 79 000 0077', department: { id: LEGAL.id, name: LEGAL.name, name_ar: null } })
    const { user, router } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'POST /reception/scan': () =>
          errorResponse(409, 'VISIT_COMPLETED', 'This visit has already been completed.', { visit: checkedOutVisit(), check_in_options: [] }),
        [`GET /visitors/${VISITOR_ID}`]: () => jsonResponse(makeVisitor()),
        'GET /departments': () => jsonResponse([FINANCE, LEGAL]),
        'GET /users/hosts': () => jsonResponse([omar]),
      },
    })
    await enterPass(user, PASS_URL)

    await waitFor(() => expect(verdictBand()).toHaveTextContent(/^Checked out at 10:00$/))
    expect(resultPanel()).not.toHaveTextContent('This visit has already been completed.')
    await user.click(within(resultPanel()).getByRole('button', { name: 'Register walk-in' }))

    expect(router.state.location.search).toBe('?tab=walk-in')
    expect(screen.getByRole('tab', { name: 'Walk-in' })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(screen.getByRole('combobox', { name: /Returning visitor/ })).toHaveValue('Élodie Martin'))
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Host' })).toHaveValue('Omar Khalil'))
    // The visit's department stays the choice (and is what the walk-in is saved under).
    expect(screen.getByRole('combobox', { name: /^Department/ })).toHaveValue(FINANCE.id)
    expect(screen.getByRole('textbox', { name: 'Purpose' })).toHaveValue('Quarterly review')
  })

  it('offers "Check again" when the scan got no verdict', async () => {
    let attempts = 0
    const { requests, user } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'POST /reception/scan': () => {
          attempts += 1
          return attempts === 1 ? errorResponse(503, 'SERVICE_BUSY', 'The service is busy. Please try again.') : jsonResponse(readyScan())
        },
      },
    })
    await enterPass(user, PASS_URL)
    expect(await within(resultPanel()).findByText('The service is busy. Please try again.', { selector: 'span' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByRole('button', { name: 'Check in' })).toBeInTheDocument()
    expect(requestsTo(requests, 'POST', '/reception/scan').map((request) => request.body)).toEqual([{ token: PASS_TOKEN }, { token: PASS_TOKEN }])
  })

  it('shows the server’s message when the check-in is refused meanwhile, and refreshes the lists', async () => {
    const { requests, user } = renderReception({
      camera: { permission: 'prompt' },
      routes: {
        'POST /reception/scan': () => jsonResponse(readyScan()),
        [`POST ${CHECK_IN}`]: () => errorResponse(409, 'VISIT_ALREADY_CHECKED_IN', 'This visitor is already checked in.'),
      },
    })
    await enterPass(user, PASS_URL)
    await user.click(await screen.findByRole('button', { name: 'Check in' }))

    expect(await within(resultPanel()).findByText('This visitor is already checked in.', { selector: 'span' })).toBeInTheDocument()
    expect(within(resultPanel()).getByRole('button', { name: 'Check pass again' })).toBeInTheDocument()
    await waitFor(() => expect(requestsTo(requests, 'GET', '/reception/today').length).toBeGreaterThan(1))
  })
})

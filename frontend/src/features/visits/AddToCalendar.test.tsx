import { act, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred, errorResponse, makeMe, mockApi } from '../../test/api'
import { makeVisit, VISIT_ID } from '../../test/fixtures'
import { renderWithProviders } from '../../test/render'
import { AddToCalendar } from './AddToCalendar'

const NOW = new Date('2026-10-05T06:10:00Z')

/** The control on a page that may drop it ("Leave"): the page's other parts, and its toasts, stay. */
function Page() {
  const [shown, setShown] = useState(true)
  return (
    <div>
      {shown && <AddToCalendar visit={makeVisit()} me={makeMe(['EMPLOYEE'])} />}
      <button type="button" onClick={() => setShown(false)}>
        Leave
      </button>
    </div>
  )
}

describe('AddToCalendar', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows no toast for a request that fails after the control left the page: the page shown then is about something else', async () => {
    const held = deferred<Response>()
    mockApi({ [`GET /visits/${VISIT_ID}`]: () => held.promise })
    const { user } = renderWithProviders(<Page />)

    await user.click(screen.getByRole('button', { name: 'Add to my calendar' }))
    await user.click(screen.getByRole('button', { name: 'Leave' }))
    held.resolve(errorResponse(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.'))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))

    expect(screen.queryAllByRole('alert').map((alert) => alert.textContent).join('')).not.toContain('The visit could not be loaded')
  })
})

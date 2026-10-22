import { act, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from './Toast'
import { useToast, type ToastApi } from './toastContext'

function Triggers() {
  const toast = useToast()
  return (
    <>
      <button type="button" onClick={() => toast.show({ tone: 'success', title: 'Visitor checked in', description: 'Élodie Martin' })}>
        Show confirmation
      </button>
      <button type="button" onClick={() => toast.show({ tone: 'danger', title: 'Could not sign out' })}>
        Show error
      </button>
    </>
  )
}

/** Session controls: reset, and an API object kept the way a pending request's callback keeps it. */
function SessionControls() {
  const toast = useToast()
  const kept = useRef<ToastApi | null>(null)
  return (
    <>
      <button type="button" onClick={() => toast.reset()}>
        Reset
      </button>
      <button
        type="button"
        onClick={() => {
          kept.current = toast
        }}
      >
        Keep API
      </button>
      <button type="button" onClick={() => kept.current?.show({ tone: 'danger', title: 'Zainab Haddad was not checked out' })}>
        Show with kept API
      </button>
    </>
  )
}

function renderSession() {
  render(
    <ToastProvider>
      <Triggers />
      <SessionControls />
    </ToastProvider>,
  )
}

function renderToasts() {
  render(
    <ToastProvider>
      <Triggers />
    </ToastProvider>,
  )
}

function press(name: string) {
  act(() => {
    screen.getByRole('button', { name }).click()
  })
}

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays at the top centre at every width, clear of the bottom and the inline end, where the actions are', () => {
    renderToasts()
    press('Show confirmation')
    const region = screen.getByText('Visitor checked in').closest('[data-toast-region]') as HTMLElement
    const classes = region.className.split(' ')
    // At the top (with the safe-area inset) and centred, with no breakpoint moving it to the bottom
    // or to the inline end: from 640 px a toast at the bottom end covered the scan result's Check in (L-21).
    expect(classes).toEqual(expect.arrayContaining(['top-0', 'items-center', 'pt-[max(1rem,env(safe-area-inset-top))]']))
    const placement = [region, ...region.querySelectorAll<HTMLElement>('[aria-live]')].flatMap((element) => element.className.split(' '))
    expect(placement.filter((name) => /(^|:)(bottom-|top-auto|items-end|items-start|justify-end)/.test(name))).toEqual([])
  })

  it('announces confirmations politely and dismisses them automatically', () => {
    renderToasts()

    press('Show confirmation')

    expect(screen.getByText('Visitor checked in').closest('[aria-live]')).toHaveAttribute('aria-live', 'polite')
    act(() => {
      vi.advanceTimersByTime(6000)
    })
    expect(screen.queryByText('Visitor checked in')).toBeNull()
  })

  it('announces errors assertively and keeps them until dismissed', () => {
    renderToasts()

    press('Show error')
    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(screen.getByText('Could not sign out').closest('[aria-live]')).toHaveAttribute('aria-live', 'assertive')
    press('Dismiss notification')
    expect(screen.queryByText('Could not sign out')).toBeNull()
  })

  it('reset removes every toast, also an error that stays until dismissed (SEC-41)', () => {
    renderSession()
    press('Show confirmation')
    press('Show error')

    press('Reset')

    expect(screen.queryByText('Visitor checked in')).toBeNull()
    expect(screen.queryByText('Could not sign out')).toBeNull()
    // The regions stay for the next session's announcements, and the new API shows toasts again.
    expect(document.querySelector('[role="alert"][aria-live="assertive"]')).not.toBeNull()
    press('Show error')
    expect(screen.getByText('Could not sign out')).toBeInTheDocument()
  })

  it('shows nothing for a callback that still holds the API from before a reset (SEC-41)', () => {
    renderSession()
    // A request of the previous session holds this API object and settles after the reset.
    press('Keep API')
    press('Reset')
    press('Show with kept API')
    expect(screen.queryByText('Zainab Haddad was not checked out')).toBeNull()

    // Before a reset the same call shows the toast.
    press('Keep API')
    press('Show with kept API')
    expect(screen.getByText('Zainab Haddad was not checked out')).toBeInTheDocument()
  })

  it('throws a clear error outside the provider', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Triggers />)).toThrow('useToast must be used inside <ToastProvider>')
    consoleError.mockRestore()
  })
})

function WithAction({ onAction }: { onAction: () => void }) {
  const toast = useToast()
  return (
    <button type="button" onClick={() => toast.show({ tone: 'danger', title: 'Alert: Maya Odeh in Floor 4 › Open office', action: { label: 'View', onAction } })}>
      Show alert
    </button>
  )
}

describe('a toast’s action (Phase 16)', () => {
  it('does what it says and takes the toast away', async () => {
    const onAction = vi.fn<() => void>()
    render(
      <ToastProvider>
        <WithAction onAction={onAction} />
      </ToastProvider>,
    )
    act(() => screen.getByRole('button', { name: 'Show alert' }).click())
    const view = screen.getByRole('button', { name: 'View' })
    expect(view.closest('[role="alert"]')).not.toBeNull()
    act(() => view.click())
    expect(onAction).toHaveBeenCalledOnce()
    expect(screen.queryByText('Alert: Maya Odeh in Floor 4 › Open office')).toBeNull()
  })
})

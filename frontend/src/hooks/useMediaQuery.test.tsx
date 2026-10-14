import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMediaQuery } from './useMediaQuery'

function Probe() {
  return <p>{useMediaQuery('(pointer: coarse)') ? 'coarse' : 'fine'}</p>
}

/** The part of MediaQueryList the hook uses. */
interface FakeMediaQueryList {
  readonly matches: boolean
  addEventListener(type: 'change', listener: () => void): void
  removeEventListener(type: 'change', listener: () => void): void
}

function installMatchMedia(initial: boolean) {
  let matches = initial
  const listeners = new Set<() => void>()
  vi.stubGlobal(
    'matchMedia',
    vi.fn<(query: string) => FakeMediaQueryList>(() => ({
      get matches() {
        return matches
      },
      addEventListener: (_type, listener) => {
        listeners.add(listener)
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener)
      },
    })),
  )
  return (next: boolean) => {
    matches = next
    for (const listener of listeners) listener()
  }
}

describe('useMediaQuery', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reflects the media query and follows changes', () => {
    const change = installMatchMedia(false)
    render(<Probe />)
    expect(screen.getByText('fine')).toBeInTheDocument()

    act(() => change(true))

    expect(screen.getByText('coarse')).toBeInTheDocument()
  })

  it('is false where matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    render(<Probe />)
    expect(screen.getByText('fine')).toBeInTheDocument()
  })
})

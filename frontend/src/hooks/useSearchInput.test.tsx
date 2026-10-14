import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSearchInput } from './useSearchInput'

function setup(initial = '') {
  const onCommit = vi.fn<(value: string) => void>()
  const hook = renderHook(({ committed }) => useSearchInput(committed, onCommit, 300), { initialProps: { committed: initial } })
  return { ...hook, onCommit }
}

describe('useSearchInput', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('commits the trimmed text once typing has stopped', () => {
    const { result, onCommit } = setup()

    act(() => result.current.setText('mar'))
    act(() => vi.advanceTimersByTime(200))
    act(() => result.current.setText('mart '))
    act(() => vi.advanceTimersByTime(299))
    expect(onCommit).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(1))
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('mart')
    expect(result.current.text).toBe('mart ')
  })

  it('commits at once on Enter and does not commit an unchanged value', () => {
    const { result, onCommit } = setup('orbit')

    act(() => result.current.setText(' orbit '))
    act(() => result.current.commitNow())
    expect(onCommit).not.toHaveBeenCalled()

    act(() => result.current.setText('omar'))
    act(() => result.current.commitNow())
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('omar')
    act(() => vi.advanceTimersByTime(1000))
    expect(onCommit).toHaveBeenCalledOnce()
  })

  it('clears the text and the committed search together', () => {
    const { result, onCommit } = setup('orbit')

    act(() => result.current.clear())

    expect(result.current.text).toBe('')
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('')
  })

  it('follows a committed value changed elsewhere (back button) without writing the old text back', () => {
    const { result, rerender, onCommit } = setup('orbit')

    rerender({ committed: 'legal' })
    expect(result.current.text).toBe('legal')
    act(() => vi.advanceTimersByTime(1000))
    expect(onCommit).not.toHaveBeenCalled()
  })
})

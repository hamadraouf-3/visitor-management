import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface SearchInputState {
  /** What the input shows (updates on every keystroke). */
  text: string
  setText: (value: string) => void
  /** Commits the current text at once (e.g. Enter), skipping the debounce. */
  commitNow: () => void
  /** Empties the input and commits the empty search at once. */
  clear: () => void
}

/**
 * A search box whose committed value lives elsewhere (usually `q` of `useUrlParams`). Typing commits
 * the trimmed text after `delayMs` without further typing. When the committed value changes
 * from outside (back button, a link), the input follows it.
 *
 * The commit is scheduled from the change handler rather than from an effect on a debounced
 * value: an effect would also run when the committed value changes from outside, and would
 * write the stale typed text back over it.
 */
export function useSearchInput(committed: string, onCommit: (value: string) => void, delayMs = 300): SearchInputState {
  const [text, setTextState] = useState(committed)
  const [syncedCommitted, setSyncedCommitted] = useState(committed)
  const timer = useRef<number | undefined>(undefined)
  // A pending timer must compare with, and report to, the latest values, not those of the
  // render that scheduled it.
  const latest = useRef({ committed, onCommit })
  useLayoutEffect(() => {
    latest.current = { committed, onCommit }
  })

  if (committed !== syncedCommitted) {
    setSyncedCommitted(committed)
    if (committed !== text.trim()) setTextState(committed)
  }

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const commit = (value: string) => {
    window.clearTimeout(timer.current)
    const trimmed = value.trim()
    if (trimmed !== latest.current.committed) latest.current.onCommit(trimmed)
  }

  return {
    text,
    setText: (value) => {
      setTextState(value)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => commit(value), delayMs)
    },
    commitNow: () => commit(text),
    clear: () => {
      setTextState('')
      commit('')
    },
  }
}

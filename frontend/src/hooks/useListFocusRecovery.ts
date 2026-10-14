import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { focusPageHeading, isFocusLost } from '../utils/focus'

/** Marks a list row (its key) whose action may remove it; see {@link useListFocusRecovery}. */
export const FOCUS_ROW_ATTRIBUTE = 'data-focus-row'
/** Marks the control of a row that takes focus when the row before it disappears. */
export const ROW_ACTION_ATTRIBUTE = 'data-row-action'

function rowsIn(list: HTMLElement | null): HTMLElement[] {
  return list ? Array.from(list.querySelectorAll<HTMLElement>(`[${FOCUS_ROW_ATTRIBUTE}]`)) : []
}

function rowTarget(row: HTMLElement | undefined): HTMLElement | null {
  if (!row) return null
  return (
    row.querySelector<HTMLElement>(`[${ROW_ACTION_ATTRIBUTE}]`) ??
    row.querySelector<HTMLElement>('button:enabled') ??
    row.querySelector<HTMLElement>('a[href]')
  )
}

interface PendingRecovery {
  /** The row the action started from; null for an action outside the rows (a bulk action). */
  key: string | null
  /** Its position among the rows when the action succeeded. */
  index: number
  /** The list's data when the action succeeded: the first new data decides. */
  version: unknown
}

/**
 * Keeps keyboard focus in a list when an action removes the control it started from (WCAG
 * 2.4.3): a check-out takes the visitor off the Inside list, a check-in off the Expected list,
 * a bulk check-out removes its own banner. The dialog of the action returns focus to its
 * trigger, and the refreshed list then drops that row, or the trigger is already gone when the
 * dialog closes; either way focus would fall to the document and a keyboard or screen-reader
 * user would start again from the top of the page.
 *
 * Call the returned `arm(rowKey)` when such an action succeeded (`null` for an action outside
 * the rows). After each render, while armed, a focus found lost to the document moves to the
 * row now at the same position, or the previous row when the removed one was the last: to its
 * `data-row-action` control (else its first button, else its first link). Without rows it goes
 * to `fallback` (the list's filter field), else to the page heading. The recovery ends once it
 * happened, or once the list's data (`version`) changed without focus being lost (the user
 * moved on, or the row stayed).
 *
 * Rows carry `data-focus-row="<key>"` and sit inside `list`.
 */
export function useListFocusRecovery({
  list,
  fallback,
  version,
}: {
  list: RefObject<HTMLElement | null>
  fallback: RefObject<HTMLElement | null>
  version: unknown
}): (rowKey: string | null) => void {
  const pending = useRef<PendingRecovery | null>(null)
  const latestVersion = useRef(version)
  useEffect(() => {
    latestVersion.current = version
  })

  const arm = useCallback(
    (rowKey: string | null) => {
      const index = rowKey === null ? -1 : rowsIn(list.current).findIndex((row) => row.getAttribute(FOCUS_ROW_ATTRIBUTE) === rowKey)
      pending.current = { key: rowKey, index, version: latestVersion.current }
    },
    [list],
  )

  useEffect(() => {
    const recovery = pending.current
    if (!recovery) return
    if (isFocusLost()) {
      pending.current = null
      const rows = rowsIn(list.current).filter((row) => row.getAttribute(FOCUS_ROW_ATTRIBUTE) !== recovery.key)
      const target = recovery.index >= 0 ? rowTarget(rows[Math.min(recovery.index, rows.length - 1)]) : null
      if (target) target.focus()
      else if (fallback.current?.isConnected) fallback.current.focus()
      else focusPageHeading()
      return
    }
    if (version !== recovery.version) pending.current = null
  })

  return arm
}

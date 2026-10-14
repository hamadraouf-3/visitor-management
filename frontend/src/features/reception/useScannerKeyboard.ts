import { useEffect, useRef, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { isEditable, isFocusIdle, isModalOpen, isPassCharacterKey } from './focusRules'

export interface ScannerKeyboardOptions {
  /** The Scan tab is shown (the pass field exists). */
  enabled: boolean
  /** `(pointer: coarse)`: the field is collapsed and never focused on its own (no on-screen keyboard). */
  coarse: boolean
  expanded: boolean
  setExpanded: (expanded: boolean) => void
  inputRef: RefObject<HTMLInputElement | null>
  /** Enter while nothing has focus: the result's primary action. */
  onEnter: () => void
}

/** How long after a Tab key press a focus change counts as keyboard navigation. */
const TAB_NAVIGATION_MS = 100

/**
 * Keeps the pass field ready for a handheld scanner (§10):
 *
 * - Fine pointer: the field takes focus whenever nothing else has it (on arrival, after a
 *   click on empty space, after the focused button disappeared). Not when the user tabbed out
 *   of the page or past its last control: that is keyboard navigation (in a kiosk without
 *   browser controls, focus rests on the document before Tab continues at the top), and taking
 *   focus back would trap Tab between the field and its button (WCAG 2.1.2).
 * - Any device: characters typed while focus is on something that does not take text (a
 *   result's button, the page) go to the field, so a scanner's next code is never lost or
 *   turned into a click. Space is excluded (it activates buttons and never occurs in a pass).
 * - Enter with nothing focused triggers the result's primary action.
 *
 * Dialogs keep the keyboard: nothing happens while one is open.
 */
export function useScannerKeyboard({ enabled, coarse, expanded, setExpanded, inputRef, onEnter }: ScannerKeyboardOptions): void {
  const latest = useRef({ coarse, expanded, setExpanded, onEnter })
  useEffect(() => {
    latest.current = { coarse, expanded, setExpanded, onEnter }
  })

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isModalOpen()) return
      const active = document.activeElement
      if (isEditable(active)) return
      if (isPassCharacterKey(event)) {
        const current = latest.current
        // The field must be rendered before it can take focus, and focus must move before the
        // browser inserts this key's character, so the expansion is flushed synchronously.
        if (current.coarse && !current.expanded) flushSync(() => current.setExpanded(true))
        inputRef.current?.focus()
        return
      }
      if (event.key === 'Enter' && isFocusIdle(active)) {
        event.preventDefault()
        latest.current.onEnter()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [enabled, inputRef])

  useEffect(() => {
    if (!enabled || coarse) return
    let timer: number | undefined
    let tabbedAt = Number.NEGATIVE_INFINITY
    const focusIfIdle = () => {
      if (!document.hasFocus() || isModalOpen() || !isFocusIdle(document.activeElement)) return
      inputRef.current?.focus()
    }
    // Deferred: the layout focuses the page heading after a navigation in the same commit, and
    // focus leaving an element is settled only after the event.
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(focusIfIdle, 0)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') tabbedAt = performance.now()
    }
    const onFocusOut = () => {
      if (performance.now() - tabbedAt < TAB_NAVIGATION_MS) return
      schedule()
    }
    const onFocusIn = (event: FocusEvent) => {
      if (isFocusIdle(event.target instanceof Element ? event.target : null)) schedule()
    }
    schedule()
    // Capture: a Tab must be seen before the focus change it causes, also if a control handles it.
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [enabled, coarse, inputRef])
}

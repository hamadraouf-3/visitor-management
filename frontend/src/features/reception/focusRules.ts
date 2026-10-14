/**
 * Keyboard and focus rules of the scanner (§10): a handheld scanner types like a keyboard and
 * ends with Enter, so the pass field must hold focus whenever nothing else does, and keys typed
 * elsewhere on the Scan tab are sent to it.
 */

/** The id of the app's main region (AppLayout), focused programmatically after navigation. */
const MAIN_CONTENT_ID = 'main-content'

/**
 * Whether focus is "nowhere" for the purpose of the scanner: on nothing, on the document body,
 * or on a landing target the layout focuses after a navigation (the main region or the page
 * heading, both only programmatically focusable).
 */
export function isFocusIdle(active: Element | null): boolean {
  if (!active || active === document.body || active === document.documentElement) return true
  if (active.id === MAIN_CONTENT_ID) return true
  return active instanceof HTMLElement && active.tagName === 'H1' && active.tabIndex === -1
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'datetime-local', 'time'])

/** Elements that take typed text themselves (they keep their keys). */
export function isEditable(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false
  if (element.isContentEditable) return true
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true
  return element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(element.type)
}

/**
 * A key that types a character of a pass (URL or token). Space is left out: it activates a
 * focused button and never occurs in a pass. Shortcuts with modifiers are left alone.
 */
export function isPassCharacterKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>): boolean {
  return event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing
}

/** A modal dialog is open (it owns the keyboard). */
export function isModalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null
}

/**
 * Whether focus may be moved into the scanner (to a result's action, or back to the pass
 * field): it is nowhere, or already inside the scanner. Focus is never taken from another part
 * of the screen (e.g. the visitor search) or from a dialog.
 */
export function mayMoveFocusInto(container: Element | null): boolean {
  if (isModalOpen()) return false
  const active = document.activeElement
  return isFocusIdle(active) || (container !== null && active !== null && container.contains(active))
}

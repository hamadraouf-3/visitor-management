const FOCUSABLE =
  'input:not([type="hidden"]):enabled, select:enabled, textarea:enabled, button:enabled, [tabindex]:not([tabindex="-1"])'

/** The element itself when focusable, else its checked radio, else its first focusable descendant. */
function focusTarget(element: HTMLElement): HTMLElement | null {
  if (element.matches(FOCUSABLE)) return element
  return (
    element.querySelector<HTMLElement>('input[type="radio"]:checked:enabled') ?? element.querySelector<HTMLElement>(FOCUSABLE)
  )
}

/**
 * Moves focus to the page's main heading (focusable with tabIndex -1, see PageHeader). For
 * when the focused control disappears, e.g. an action button the action itself removed, so
 * keyboard and screen-reader users continue from the top of the content, not the document.
 */
export function focusPageHeading(): void {
  document.querySelector<HTMLElement>('main h1')?.focus()
}

/** Whether focus was lost to the document (the focused element was removed or disabled). */
export function isFocusLost(): boolean {
  const active = document.activeElement
  return active === null || active === document.body || active === document.documentElement
}

/**
 * Focuses the control that comes first in the document among the elements with the given
 * ids. An id may name a group (e.g. a radio group's fieldset); then its checked or first
 * enabled control gets focus. Returns false when none of them can take focus.
 */
export function focusFirstControl(ids: readonly string[]): boolean {
  const elements = ids
    .map((id) => document.getElementById(id))
    .filter((element): element is HTMLElement => element !== null)
    .toSorted((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  for (const element of elements) {
    const target = focusTarget(element)
    if (target) {
      target.focus()
      return true
    }
  }
  return false
}

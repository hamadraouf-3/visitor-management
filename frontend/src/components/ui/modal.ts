import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

const TABBABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(',')

/** Attribute that keeps an element interactive while a modal is open (e.g. the toast region). */
export const KEEP_INTERACTIVE_ATTRIBUTE = 'data-modal-keep-interactive'
/** Marks the element a portal renders into document.body for a modal. */
export const MODAL_ROOT_ATTRIBUTE = 'data-modal-root'
/** Marks a modal's close button so initial focus prefers the content. */
export const MODAL_CLOSE_ATTRIBUTE = 'data-modal-close'

/** Keyboard-reachable elements inside `container`, in DOM order. */
export function getTabbableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0 && !element.closest('[hidden],[inert],[aria-hidden="true"]'),
  )
}

/** Open modals, innermost last; only the innermost one traps focus and handles Escape. */
const modalStack: HTMLElement[] = []

let scrollLocks = 0
let previousBodyOverflow = ''

function lockScroll() {
  if (scrollLocks === 0) {
    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  scrollLocks += 1
}

function unlockScroll() {
  scrollLocks = Math.max(0, scrollLocks - 1)
  if (scrollLocks === 0) document.body.style.overflow = previousBodyOverflow
}

/** Makes every other top-level body child inert; returns the elements it changed. */
function inertOutside(modalRoot: Element | null): HTMLElement[] {
  const changed: HTMLElement[] = []
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement) || child === modalRoot) continue
    if (child.hasAttribute('inert') || child.hasAttribute(KEEP_INTERACTIVE_ATTRIBUTE)) continue
    if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue
    child.setAttribute('inert', '')
    changed.push(child)
  }
  return changed
}

function initialFocusTarget(panel: HTMLElement, preferred: HTMLElement | null | undefined): HTMLElement {
  if (preferred) return preferred
  const tabbables = getTabbableElements(panel)
  return tabbables.find((element) => !element.hasAttribute(MODAL_CLOSE_ATTRIBUTE)) ?? tabbables[0] ?? panel
}

interface ModalBehaviorOptions {
  open: boolean
  onClose: () => void
  panelRef: RefObject<HTMLElement | null>
  initialFocusRef?: RefObject<HTMLElement | null>
}

/**
 * Modal semantics for Dialog and Drawer: focus moves into the panel, Tab/Shift+Tab cycle
 * inside it, Escape closes, the rest of the page is inert and does not scroll, and focus
 * returns to the previously focused element on close.
 */
export function useModalBehavior({ open, onClose, panelRef, initialFocusRef }: ModalBehaviorOptions): void {
  const onCloseRef = useRef(onClose)
  useLayoutEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    const panel = panelRef.current
    if (!open || !panel) return

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    modalStack.push(panel)
    const inerted = inertOutside(panel.closest(`[${MODAL_ROOT_ATTRIBUTE}]`))
    lockScroll()
    initialFocusTarget(panel, initialFocusRef?.current).focus()

    const isInnermost = () => modalStack[modalStack.length - 1] === panel

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isInnermost() || event.defaultPrevented) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const tabbables = getTabbableElements(panel)
      const first = tabbables[0]
      const last = tabbables[tabbables.length - 1]
      if (!first || !last) {
        event.preventDefault()
        panel.focus()
        return
      }
      const active = document.activeElement
      const outside = !(active instanceof Node) || !panel.contains(active)
      if (event.shiftKey && (active === first || active === panel || outside)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault()
        first.focus()
      }
    }

    const handleFocusIn = (event: FocusEvent) => {
      if (!isInnermost()) return
      if (event.target instanceof Node && !panel.contains(event.target)) {
        initialFocusTarget(panel, null).focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('focusin', handleFocusIn)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('focusin', handleFocusIn)
      const index = modalStack.indexOf(panel)
      if (index !== -1) modalStack.splice(index, 1)
      for (const element of inerted) element.removeAttribute('inert')
      unlockScroll()
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [open, panelRef, initialFocusRef])
}

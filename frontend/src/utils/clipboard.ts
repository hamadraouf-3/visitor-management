/**
 * Copies text to the clipboard; resolves to whether it worked.
 *
 * The async Clipboard API exists only in secure contexts, so a tablet that opens the app
 * over plain http on the LAN falls back to the legacy `execCommand('copy')` path, which
 * browsers still support for a user-initiated copy.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied or document not focused: try the legacy path below.
    }
  }
  return copyWithSelection(text)
}

function copyWithSelection(text: string): boolean {
  if (typeof document.execCommand !== 'function') return false
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.setAttribute('aria-hidden', 'true')
  // CSSOM properties (not a style attribute), so the strict style-src CSP still allows them.
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '0'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.append(textarea)
  try {
    textarea.focus({ preventScroll: true })
    textarea.select()
    // iOS Safari ignores select() on a read-only field.
    textarea.setSelectionRange(0, text.length)
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    textarea.remove()
    previousFocus?.focus({ preventScroll: true })
  }
}

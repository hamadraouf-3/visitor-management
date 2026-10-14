import type { Page } from '@playwright/test'

/*
 * What a tap reaches of each control on a page, measured on screen with elementFromPoint, the way a
 * touch lands: a control's own box says little (a name link's hit area is its whole card, a
 * checkbox is ticked through its label, a link's touch area is padded outside its text). The UX
 * review of Phase 12 listed controls "under 44 px" by their boxes; this measures the band a finger
 * can use, across and down through the point a tap lands on.
 */

export interface TouchTarget {
  /** The control's tag and its words, to name it in a failure. */
  what: string
  /** The control's own box. */
  box: { width: number; height: number }
  /** The run of points through the control, across and down, where a tap activates it (px). */
  reach: { width: number; height: number }
}

/**
 * Every control of the page a person can tap, with what a tap reaches of it. Controls that are not
 * on screen for a touch (hidden, inert, shown only on keyboard focus) are left out.
 */
export function measureTouchTargets(page: Page): Promise<TouchTarget[]> {
  return page.evaluate(() => {
    const SELECTOR = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="radio"]'
    /** Whether a tap at the point activates the control: it lands on it, inside it, or on its label. */
    // Runs in the page, with the rest of this function: it cannot live outside it.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const activates = (control: Element, x: number, y: number) => {
      const hit = document.elementFromPoint(x, y)
      if (!hit) return false
      if (control.contains(hit)) return true
      const label = hit.closest('label')
      return label !== null && label.control === control
    }
    const targets: TouchTarget[] = []
    for (const control of document.querySelectorAll<HTMLElement>(SELECTOR)) {
      const style = getComputedStyle(control)
      if (style.visibility === 'hidden' || style.display === 'none' || control.closest('[hidden], [aria-hidden="true"], [inert]')) continue
      const labels = (control as HTMLInputElement).labels
      const hiddenInput = control.tagName === 'INPUT' && control.classList.contains('sr-only')
      // The skip link and its like: on screen only while the keyboard is on them.
      if (!hiddenInput && control.classList.contains('sr-only')) continue
      if (!hiddenInput && (control.offsetWidth === 0 || control.offsetHeight === 0)) continue
      control.scrollIntoView({ block: 'center' })
      const rect = control.getBoundingClientRect()
      // A point of the control a tap reaches: its centre, else the middle of its label (a visually hidden radio or checkbox).
      let x = rect.left + rect.width / 2
      let y = rect.top + rect.height / 2
      if (!activates(control, x, y)) {
        const label = labels?.[0]?.getBoundingClientRect()
        if (!label) continue
        x = label.left + label.width / 2
        y = label.top + label.height / 2
        if (!activates(control, x, y)) continue
      }
      let [left, right, top, bottom] = [x, x, y, y]
      while (left > 0 && activates(control, left - 1, y)) left -= 1
      while (right < innerWidth - 1 && activates(control, right + 1, y)) right += 1
      while (top > 0 && activates(control, x, top - 1)) top -= 1
      while (bottom < innerHeight - 1 && activates(control, x, bottom + 1)) bottom += 1
      const words = (control.innerText || control.getAttribute('aria-label') || control.getAttribute('title') || labels?.[0]?.innerText || control.getAttribute('type') || '').trim().replaceAll(/\s+/g, ' ')
      targets.push({
        what: `${control.tagName.toLowerCase()} “${words.slice(0, 48)}”`,
        box: { width: Math.round(rect.width), height: Math.round(rect.height) },
        reach: { width: Math.round(right - left + 1), height: Math.round(bottom - top + 1) },
      })
    }
    return targets
  })
}

/** The targets a finger cannot use: reached over less than `minimum` px across or down. */
export function tooSmall(targets: readonly TouchTarget[], minimum = 44): string[] {
  return targets.filter((target) => target.reach.width < minimum || target.reach.height < minimum).map((target) => `${target.what}: ${target.reach.width} × ${target.reach.height} px (its box ${target.box.width} × ${target.box.height})`)
}

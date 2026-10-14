import { expect, type Locator, type Page } from '@playwright/test'

/*
 * A focus indicator measured on screen (WCAG 1.4.11 non-text contrast), as the accessibility audit
 * measured it: the pixels around a control that change when it takes keyboard focus, on a line
 * through the middle of each side, and the contrast between their focused and unfocused colors.
 * Outside the control the unfocused color is whatever lies around it (e.g. the camera picture under
 * the reception scanner's "Turn camera off"); inside it, the control's own background (a ring drawn
 * inside a tab of a scrolling tab list).
 */

export type Rgb = [number, number, number]

export interface RingSide {
  side: 'top' | 'right' | 'bottom' | 'left'
  /** Pixels on the line through the middle of the side that change with focus. */
  changed: number
  /** The highest contrast between the focused and the unfocused color of those pixels. */
  contrast: number
}

function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((value) => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }) as Rgb
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}

/** The WCAG 2.x contrast ratio of two sRGB colors. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].toSorted((x, y) => y - x) as [number, number]
  return (high + 0.05) / (low + 0.05)
}

export function hexToRgb(hex: string): Rgb {
  const value = Number.parseInt(hex.replace('#', ''), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

interface Bitmap {
  width: number
  height: number
  data: number[]
}

/** Decodes a PNG screenshot in the page (no image library in Node). */
async function decode(page: Page, png: Buffer): Promise<Bitmap> {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No 2D canvas context')
    context.drawImage(bitmap, 0, 0)
    return { width: bitmap.width, height: bitmap.height, data: Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data) }
  }, png.toString('base64'))
}

function pixel(bitmap: Bitmap, x: number, y: number): Rgb {
  const index = (Math.round(y) * bitmap.width + Math.round(x)) * 4
  return [bitmap.data[index]!, bitmap.data[index + 1]!, bitmap.data[index + 2]!]
}

/** The color on screen at a point of the page's viewport. */
export async function colorAt(page: Page, point: { x: number; y: number }): Promise<Rgb> {
  const bitmap = await decode(page, await page.screenshot({ clip: { x: Math.floor(point.x), y: Math.floor(point.y), width: 1, height: 1 } }))
  return pixel(bitmap, 0, 0)
}

/**
 * Focuses a control as the keyboard does, so it matches `:focus-visible` (after a click, a
 * script's focus() may not).
 */
export async function focusVisibly(page: Page, control: Locator): Promise<void> {
  await control.focus()
  if (!(await control.evaluate((element) => element.matches(':focus-visible')))) {
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
  }
  await expect(control).toBeFocused()
  expect(await control.evaluate((element) => element.matches(':focus-visible')), 'the control shows keyboard focus').toBe(true)
}

/**
 * The focus indicator of `control` on each of its four sides: on a line through the middle of each
 * side, from `inside` px within the control to `outside` px out from it, the pixels that change
 * between the unfocused and the focused control, and their best contrast between the two states.
 * Leaves the control focused.
 */
export async function focusIndicator(page: Page, control: Locator, { inside = 0, outside = 8 }: { inside?: number; outside?: number } = {}): Promise<RingSide[]> {
  const box = await control.boundingBox()
  if (!box) throw new Error('The control is not visible')
  const viewport = page.viewportSize()
  const left = Math.max(0, Math.floor(box.x - outside - 1))
  const top = Math.max(0, Math.floor(box.y - outside - 1))
  const right = Math.ceil(box.x + box.width + outside + 1)
  const bottom = Math.ceil(box.y + box.height + outside + 1)
  const clip = { x: left, y: top, width: (viewport ? Math.min(right, viewport.width) : right) - left, height: (viewport ? Math.min(bottom, viewport.height) : bottom) - top }
  await control.evaluate((element: HTMLElement) => element.blur())
  // Transitions (e.g. `transition-colors` on the outline color) are finished before the capture.
  const unfocused = await decode(page, await page.screenshot({ clip, animations: 'disabled' }))
  await focusVisibly(page, control)
  const focused = await decode(page, await page.screenshot({ clip, animations: 'disabled' }))

  const x0 = box.x - clip.x
  const y0 = box.y - clip.y
  const x1 = x0 + box.width
  const y1 = y0 + box.height
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  // Distance from the side's edge: negative within the control, 0 the first pixel outside it.
  const sides: Record<RingSide['side'], (distance: number) => [number, number]> = {
    top: (distance) => [cx, Math.floor(y0) - 1 - distance],
    right: (distance) => [Math.ceil(x1) + distance, cy],
    bottom: (distance) => [cx, Math.ceil(y1) + distance],
    left: (distance) => [Math.floor(x0) - 1 - distance, cy],
  }
  return Object.entries(sides).map(([side, at]) => {
    let changed = 0
    let contrast = 0
    for (let distance = -inside; distance < outside; distance += 1) {
      const [x, y] = at(distance)
      if (x < 0 || y < 0 || x >= focused.width || y >= focused.height) continue
      const ratio = contrastRatio(pixel(unfocused, x, y), pixel(focused, x, y))
      if (ratio <= 1.1) continue
      changed += 1
      contrast = Math.max(contrast, ratio)
    }
    return { side: side as RingSide['side'], changed, contrast }
  })
}

/** Each side's contrast, for messages and annotations. */
export function describeRing(sides: RingSide[]): string {
  return sides.map((side) => `${side.side} ${side.contrast.toFixed(2)}:1 (${side.changed} px)`).join(', ')
}

/** On every side the indicator is there, at least 2 px, and changes the pixels by at least 3:1 (WCAG 1.4.11). */
export function expectVisibleRing(sides: RingSide[], what: string): void {
  for (const side of sides) {
    expect(side.changed, `${what}: focus indicator pixels on the ${side.side} (${describeRing(sides)})`).toBeGreaterThanOrEqual(2)
    expect(side.contrast, `${what}: contrast of the focus indicator on the ${side.side} (${describeRing(sides)})`).toBeGreaterThanOrEqual(3)
  }
}

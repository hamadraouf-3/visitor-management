/*
 * Colour arithmetic for a company's identity (Phase 12): WCAG 2.x relative luminance and contrast,
 * and mixing in sRGB. Colours are `#rrggbb`, lower case, as the API sends them.
 */

export const WHITE = '#ffffff'
export const BLACK = '#000000'

const HEX_COLOUR = /^#[0-9a-f]{6}$/

/** A colour exactly as the contract writes it: `#rrggbb`, lower case. */
export function isHexColour(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOUR.test(value)
}

/** What a person may type or paste: `#RGB`, `RGB`, `#RRGGBB`, any case, spaces around. Null when it is no colour. */
export function normaliseHexColour(input: string): string | null {
  const text = input.trim().toLowerCase().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/.test(text)) return `#${[...text].map((digit) => digit + digit).join('')}`
  if (/^[0-9a-f]{6}$/.test(text)) return `#${text}`
  return null
}

export type Rgb = readonly [number, number, number]

export function toRgb(hex: string): Rgb {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)]
}

function hexChannel(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, '0')
}

export function toHex([r, g, b]: Rgb): string {
  return `#${hexChannel(r)}${hexChannel(g)}${hexChannel(b)}`
}

/** WCAG 2.x relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((value) => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.x contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** `amount` of `target` mixed into `colour`, per channel in sRGB (0: the colour, 1: the target). */
export function mix(colour: string, target: string, amount: number): string {
  const [from, to] = [toRgb(colour), toRgb(target)]
  const share = Math.min(1, Math.max(0, amount))
  return toHex([0, 1, 2].map((index) => from[index]! + (to[index]! - from[index]!) * share) as unknown as Rgb)
}

/** How far two colours are apart (RGB, 0 to about 441). */
export function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** Hue (degrees), saturation and lightness (0 to 1), as HSL has them. */
export function toHsl(hex: string): { hue: number; saturation: number; lightness: number } {
  const [r, g, b] = toRgb(hex).map((value) => value / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const lightness = (max + min) / 2
  if (delta === 0) return { hue: 0, saturation: 0, lightness }
  const sector = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return { hue: (sector * 60 + 360) % 360, saturation: delta / (1 - Math.abs(2 * lightness - 1)), lightness }
}

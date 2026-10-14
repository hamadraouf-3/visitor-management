import { readFileSync } from 'node:fs'

/*
 * Reads the colour tokens of `src/index.css` and holds the pairs every token set must keep (tests
 * only, Node environment): `designTokens.test.ts` checks the product's own colours, and
 * `identity/tokens.test.ts` the same pairs with companies' palettes on them (Phase 12).
 */

export const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

/** The declarations of the first block that follows `header` (braces balanced). */
export function block(header: string): string {
  const start = css.indexOf(header)
  if (start < 0) throw new Error(`No ${header} in index.css`)
  const open = css.indexOf('{', start)
  let depth = 0
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    if (css[index] === '}') depth -= 1
    if (depth === 0) return css.slice(open + 1, index)
  }
  throw new Error(`Unbalanced ${header}`)
}

export type Tokens = Record<string, string>

/**
 * `--color-name: #rrggbb` declarations, and `--color-name: var(--brand-…, #rrggbb)` ones by their
 * fallback: the product's own colour, which applies when no company's palette is set (other values,
 * such as rgb() overlays, are not compared).
 */
export function colours(source: string): Tokens {
  const tokens: Tokens = {}
  for (const match of source.matchAll(/--color-([\w-]+):\s*(?:var\(--brand-[\w-]+,\s*)?(#[0-9a-fA-F]{6})\b/g)) tokens[match[1]!] = match[2]!.toLowerCase()
  return tokens
}

/** The tokens of a block that read a company's colour: token name → the `--brand-…` property it reads. */
export function brandProperties(source: string): Record<string, string> {
  const properties: Record<string, string> = {}
  for (const match of source.matchAll(/--color-([\w-]+):\s*var\((--brand-[\w-]+),/g)) properties[match[1]!] = match[2]!
  return properties
}

/** The header of each token set's block. */
export const SET_HEADERS = {
  light: '@theme static',
  dark: '@utility theme-dark',
  shell: '@utility theme-shell {',
  deep: '@utility theme-shell-deep',
} as const

/** The dark scheme's own declarations on the root (the emphasis tile), under the `scheme-dark` variant (Phase 13). */
export const DARK_SCHEME_ROOT = ':root {\n    @variant scheme-dark'

export const light = colours(block(SET_HEADERS.light))
export const dark = { ...light, ...colours(block(SET_HEADERS.dark)) }
export const shell = { ...light, ...colours(block(SET_HEADERS.shell)) }
export const deepShell = { ...light, ...colours(block(SET_HEADERS.deep)) }
/** The platform owner's shell in the dark colour scheme (the slate; in the light scheme it is the deep shell). */
export const slateShell = { ...light, ...colours(block('@utility theme-shell-slate')) }
export const darkSchemeEmphasis = colours(block(DARK_SCHEME_ROOT)).emphasis

export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].toSorted((x, y) => y - x) as [number, number]
  return (high + 0.05) / (low + 0.05)
}

/** [foreground, background, minimum] by token name. */
export type Pair = [string, string, number]

export function failures(tokens: Tokens, pairs: readonly Pair[]): string[] {
  return pairs.flatMap(([fg, bg, minimum]) => {
    const [a, b] = [tokens[fg], tokens[bg]]
    if (!a || !b) return [`${fg} on ${bg}: missing token`]
    const ratio = contrast(a, b)
    return ratio + 1e-9 >= minimum ? [] : [`${fg} ${a} on ${bg} ${b}: ${ratio.toFixed(2)}:1 < ${minimum}:1`]
  })
}

export const TEXT = 4.5
export const UI = 3

/** The pairs of the content area, light or dark. */
export const CONTENT_PAIRS: readonly Pair[] = [
  ['fg', 'surface', TEXT],
  ['fg', 'canvas', TEXT],
  ['fg', 'surface-muted', TEXT],
  ['fg', 'row-highlight', TEXT],
  ['fg-secondary', 'surface', TEXT],
  ['fg-secondary', 'canvas', TEXT],
  ['fg-secondary', 'tab-track', TEXT],
  ['fg-muted', 'surface', TEXT],
  ['fg-muted', 'canvas', TEXT],
  ['fg-muted', 'surface-muted', TEXT],
  ['fg-muted', 'surface-sunken', TEXT],
  ['fg-muted', 'row-highlight', TEXT],
  ['fg-placeholder', 'surface', TEXT],
  ['border-strong', 'surface', UI],
  ['border-strong', 'canvas', UI],
  ['on-accent', 'accent', TEXT],
  ['on-accent', 'accent-hover', TEXT],
  ['accent-text', 'surface', TEXT],
  ['accent-text', 'canvas', TEXT],
  ['accent-text', 'accent-surface', TEXT],
  ['focus', 'surface', UI],
  ['focus', 'canvas', UI],
  ['on-tab-selected', 'tab-selected', TEXT],
  ['tab-indicator', 'tab-track', UI],
  ['on-attention', 'attention', TEXT],
  ['on-highlight', 'highlight', TEXT],
  ['on-selection', 'selection', TEXT],
  ['on-ink', 'ink', TEXT],
  ['on-ink', 'ink-hover', TEXT],
  ['on-danger', 'danger-solid', TEXT],
  ['on-danger', 'danger-hover', TEXT],
  ...(['info', 'success', 'warning', 'danger', 'neutral'] as const).flatMap((tone): Pair[] => [
    [`${tone}-text`, `${tone}-surface`, TEXT],
    [`${tone}-solid`, `${tone}-surface`, UI],
  ]),
  ...(['scheduled', 'in', 'out', 'noshow'] as const).map((status): Pair => [`status-${status}-fg`, `status-${status}-bg`, TEXT]),
  ['status-cancelled-fg', 'surface', TEXT],
  ['chart-1', 'surface', UI],
  ['on-media', 'media', TEXT],
  ['on-media-muted', 'media', TEXT],
]

/** What the dark surfaces add: the accent as an indicator, the selected tab on its track. */
export const DARK_PAIRS: readonly Pair[] = [
  ['accent', 'surface', UI],
  ['accent', 'canvas', UI],
  ['tab-selected', 'tab-track', UI],
]

/**
 * The pairs of a shell (teal or deep; a company's own colour, dark or light): its text, the current
 * page's pill, the focus ring, the signed-in user's tile.
 */
export const SHELL_PAIRS: readonly Pair[] = [
  ['fg', 'shell', TEXT],
  ['fg-secondary', 'shell', TEXT],
  ['fg-muted', 'shell', TEXT],
  ['fg', 'surface', TEXT],
  ['fg-muted', 'surface', TEXT],
  ['fg', 'surface-muted', TEXT],
  ['fg', 'surface-raised', TEXT],
  ['fg-muted', 'surface-raised', TEXT],
  ['danger-text', 'surface-raised', TEXT],
  ['border-strong', 'shell', UI],
  ['accent', 'shell', UI],
  ['on-accent', 'accent', TEXT],
  ['on-accent', 'accent-hover', TEXT],
  ['accent-text', 'shell', TEXT],
  ['focus', 'shell', UI],
  ['on-highlight', 'highlight', TEXT],
  ['neutral-text', 'neutral-surface', TEXT],
]

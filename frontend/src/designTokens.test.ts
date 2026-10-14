// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME_COLORS, PLATFORM_THEME_COLORS } from './identity/tokens'
import { block, CONTENT_PAIRS, contrast, css, dark, DARK_PAIRS, darkSchemeEmphasis, deepShell, failures, light, shell, SHELL_PAIRS, slateShell, TEXT } from './test/designTokens'

/*
 * The colour tokens of `index.css` (mawdoo3.com's palette, F10-27) keep their contrast: every text
 * and background pair a component draws, and every boundary, indicator and focus ring, in each of
 * the five token sets (light; dark: the dark scheme, `theme-dark`; the teal shell; the deep shell;
 * the slate shell, the platform owner's in the dark scheme).
 * The ratios noted beside the tokens are what this computes (WCAG 2.x relative luminance).
 */

/** Hue (degrees) and saturation (0 to 1) of a colour, as HSL has them. */
function hsl(hex: string): { hue: number; saturation: number } {
  const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return { hue: 0, saturation: 0 }
  const lightness = (max + min) / 2
  const sector = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return { hue: (sector * 60 + 360) % 360, saturation: delta / (1 - Math.abs(2 * lightness - 1)) }
}

const hue = (hex: string) => hsl(hex).hue
const saturation = (hex: string) => hsl(hex).saturation

describe('design tokens (mawdoo3.com palette)', () => {
  it('uses mawdoo3.com’s own colours for the shell, the actions and the text', () => {
    expect(light.shell).toBe('#188086')
    expect(light.accent).toBe('#188086')
    expect(light['fg-secondary']).toBe('#33444e')
    expect(light.canvas).toBe('#f1f1f1')
    expect(light['surface-sunken']).toBe('#f8f8f8')
    expect(light.attention).toBe('#f7b916')
    expect(light.highlight).toBe('#49cbd2')
    expect(dark.accent).toBe('#27b5bb')
    // The navy of the foundation is gone.
    expect(css).not.toMatch(/#0b1020/i)
  })

  it('keeps every text, boundary and focus pair of the light content area accessible', () => {
    expect(failures(light, CONTENT_PAIRS)).toEqual([])
  })

  it('keeps them accessible on the dark surfaces (dark scheme, theme-dark: the reception tablet)', () => {
    expect(failures(dark, CONTENT_PAIRS)).toEqual([])
    expect(failures(dark, DARK_PAIRS)).toEqual([])
  })

  it('keeps the teal shell and the deep shell accessible', () => {
    expect(failures(shell, SHELL_PAIRS)).toEqual([])
    expect(failures(deepShell, SHELL_PAIRS)).toEqual([])
  })

  it('gives the platform owner a shell that is a company’s in neither colour scheme (UX review L10)', () => {
    // Light scheme: the deep teal beside the companies' side-nav teal. Dark scheme: the companies' shell
    // is the deep teal (`theme-shell` applies `theme-shell-deep` there), so the platform's is the slate.
    const platform = block('@utility theme-shell-platform')
    // The dark scheme is the device's appearance (Phase 13): the `scheme-dark` variant, never the media feature.
    expect(platform).toMatch(/@apply theme-shell-deep;[^}]*@variant scheme-dark [{][^}]*@apply theme-shell-slate;/)
    expect(block('@utility theme-shell {')).toMatch(/@variant scheme-dark [{][^}]*@apply theme-shell-deep;/)
    expect(deepShell.shell).not.toBe(shell.shell)
    expect(slateShell.shell).not.toBe(deepShell.shell)
    // mawdoo3.com's slate, its own dark colour: another hue than the teal, whose lightness it nearly shares.
    expect(slateShell.shell).toBe(light['ink-700'])
    expect(hue(slateShell.shell!) - hue(deepShell.shell!)).toBeGreaterThan(15)
    expect(saturation(deepShell.shell!)).toBeGreaterThan(2.5 * saturation(slateShell.shell!))
    // It stands off the dark content too.
    expect(contrast(slateShell.shell!, dark.canvas!)).toBeGreaterThan(1.5)
    expect(failures(slateShell, SHELL_PAIRS)).toEqual([])
    // The account block's second line, also while the block is hovered (axe found 4.29:1 there in the live check).
    expect(
      failures(slateShell, [
        ['fg-secondary', 'surface', TEXT],
        ['fg-secondary', 'surface-muted', TEXT],
        ['fg-muted', 'surface-muted', TEXT],
        ['accent-text', 'surface-raised', TEXT],
      ]),
    ).toEqual([])
  })

  it('gives the browser’s chrome the shell drawn in each scheme: the companies’ default one, and the platform owner’s own in its area', () => {
    // `theme-color` (identity/document.ts): `theme-shell`, the deep shell in the dark scheme; `theme-shell-platform`, the slate there.
    expect(DEFAULT_THEME_COLORS).toEqual({ light: shell.shell, dark: deepShell.shell })
    expect(PLATFORM_THEME_COLORS).toEqual({ light: deepShell.shell, dark: slateShell.shell })
  })

  it('never puts white text on the turquoise (2.50:1): the turquoise carries ink text', () => {
    expect(contrast('#ffffff', light['brand-400']!)).toBeLessThan(TEXT)
    expect(dark['on-accent']).not.toBe('#ffffff')
    expect(contrast(dark['on-accent']!, dark.accent!)).toBeGreaterThanOrEqual(TEXT)
  })

  it('keeps the dark emphasis tile readable in both schemes', () => {
    expect(darkSchemeEmphasis).toBeDefined()
    for (const emphasis of [light.emphasis!, darkSchemeEmphasis!]) {
      expect(contrast(light.highlight!, emphasis)).toBeGreaterThanOrEqual(TEXT)
      expect(contrast(dark['fg-secondary']!, emphasis)).toBeGreaterThanOrEqual(TEXT)
      expect(contrast(dark['fg-muted']!, emphasis)).toBeGreaterThanOrEqual(TEXT)
    }
  })
})

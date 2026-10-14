// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  block,
  css,
  brandProperties,
  colours,
  CONTENT_PAIRS,
  contrast,
  dark,
  DARK_PAIRS,
  DARK_SCHEME_ROOT,
  darkSchemeEmphasis,
  deepShell,
  failures,
  light,
  SET_HEADERS,
  shell,
  SHELL_PAIRS,
  TEXT,
  type Pair,
  type Tokens,
  UI,
} from '../test/designTokens'
import { referencePalette, SAMPLE_COLOURS } from '../test/palettes'
import serverPalettes from '../test/serverPalettes.json'
import type { BrandPalette } from '../types/api'
import { isLightSurface, paletteProblems } from './brand'
import { BLACK, luminance, mix, toHex, WHITE } from './colour'
import { IDENTITY_CHANGE_ATTRIBUTE } from './document'
import {
  applyBrandVariables,
  BRAND_TOKEN_NAMES,
  BRAND_VARIABLE_NAMES,
  brandTokens,
  brandVariable,
  brandVariables,
  DEFAULT_THEME_COLORS,
  NEUTRALS,
  NONE,
  SHELL_SCHEME_VARIABLE,
  themeColors,
  TOKEN_SETS,
  type TokenSet,
} from './tokens'

/*
 * A company's palette on the design tokens (Phase 12): the stylesheet and the mapping name the same
 * properties, and every text, boundary and focus pair the product's own colours keep
 * (`designTokens.test.ts`) holds with a company's palette on them, whatever the colour: the awkward
 * ones by name, and palettes that only just keep the contract's guarantees.
 */

/** The tokens the stylesheet draws with for a palette, per set, as the cascade resolves them. */
function tokenSets(palette: BrandPalette) {
  const tokens = brandTokens(palette)
  // Every set inherits what it does not declare from the root (the light set, a company's colours included).
  const root = { ...light, ...tokens.light }
  return {
    light: root,
    dark: { ...root, ...colours(block(SET_HEADERS.dark)), ...tokens.dark },
    shell: { ...root, ...colours(block(SET_HEADERS.shell)), ...tokens.shell },
    deep: { ...root, ...colours(block(SET_HEADERS.deep)), ...tokens.deep },
  } satisfies Record<TokenSet, Tokens>
}

/** What a company's colours add to the pairs of `designTokens.test.ts`. */
const LIGHT_EXTRA: readonly Pair[] = [
  ['fg', 'accent-surface', TEXT],
  ['fg-muted', 'accent-surface', TEXT],
  ['accent-text', 'surface-muted', TEXT],
  ['accent-text', 'surface-sunken', TEXT],
  ['accent-text', 'row-highlight', TEXT],
  // The numeral of the emphasis tile.
  ['highlight', 'emphasis', TEXT],
  ['tab-indicator', 'tab-selected', UI],
  ['chart-1', 'canvas', UI],
  // The brand as a line or a mark: a chosen option's border, a native checkbox, a meter, a hovered bar.
  ['accent-strong', 'surface', UI],
  ['accent-strong', 'canvas', UI],
  ['accent-strong', 'accent-surface', UI],
  ['accent-strong-hover', 'surface', UI],
  ['accent-strong-hover', 'canvas', UI],
]
const DARK_EXTRA: readonly Pair[] = [
  ['fg', 'accent-surface', TEXT],
  ['fg-muted', 'accent-surface', TEXT],
  ['accent-text', 'surface-muted', TEXT],
  ['accent-text', 'surface-raised', TEXT],
  ['accent-text', 'row-highlight', TEXT],
  ['focus', 'surface-raised', UI],
  ['chart-1', 'surface', UI],
  // The emphasis tile of the dark scheme: its numeral and its texts.
  ['highlight', 'emphasis', TEXT],
  ['fg', 'emphasis', TEXT],
  ['fg-muted', 'emphasis', TEXT],
]

/** `rgb(r g b / a)` laid over a colour: what a person sees of an overlay token on that surface. */
function over(token: string, under: string): string {
  const match = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(token)
  if (!match) return token
  return mix(under, toHex([Number(match[1]), Number(match[2]), Number(match[3])]), Number(match[4]))
}

/**
 * A shell's tokens as its pairs meet them: a hover fill that is the ink laid over the surface below
 * (a light shell's) is checked on each surface it lies on: the shell, its cards and its menus.
 */
function shellViews(tokens: Tokens): Tokens[] {
  const hover = tokens['surface-muted']!
  if (hover.startsWith('#')) return [tokens]
  return ['shell', 'surface', 'surface-raised'].map((under) => ({ ...tokens, 'surface-muted': over(hover, tokens[under]!) }))
}

const shellFailures = (tokens: Tokens) => [...new Set(shellViews(tokens).flatMap((view) => failures(view, SHELL_PAIRS)))]

function failuresOf(palette: BrandPalette): string[] {
  const sets = tokenSets(palette)
  return [
    ...failures(sets.light, [...CONTENT_PAIRS, ...LIGHT_EXTRA]).map((failure) => `light: ${failure}`),
    ...failures(sets.dark, [...CONTENT_PAIRS, ...DARK_PAIRS, ...DARK_EXTRA]).map((failure) => `dark: ${failure}`),
    // A dark panel inside a light page (`theme-dark` without the dark scheme) keeps the ink emphasis.
    ...failures({ ...sets.dark, emphasis: light.emphasis! }, [['highlight', 'emphasis', TEXT]]).map((failure) => `dark panel: ${failure}`),
    ...shellFailures(sets.shell).map((failure) => `shell: ${failure}`),
    ...failures(sets.deep, SHELL_PAIRS).map((failure) => `deep: ${failure}`),
  ]
}

/** A deterministic random source (mulberry32). */
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** `colour` moved towards `toward` until `passes`, in 1 % steps: a colour that only just passes. */
function barely(colour: string, toward: string, passes: (candidate: string) => boolean): string {
  for (let step = 0; step <= 100; step += 1) {
    const candidate = mix(colour, toward, step / 100)
    if (passes(candidate)) return candidate
  }
  return toward
}

/**
 * A palette whose roles keep the contract's guarantees and nothing more: each role is a colour of
 * its own hue, moved only as far as its guarantee needs. Harder than any palette derived from one
 * colour: the mapping may rely on the guarantees alone.
 */
function minimalPalette(next: () => number): BrandPalette {
  const colour = () => toHex([next() * 255, next() * 255, next() * 255])
  const onBright = mix(colour(), BLACK, 0.8 + next() * 0.2)
  // A surface of either kind, and a hover step of a hue of its own: each only just carries its ink.
  const onSurface = next() < 0.5 ? WHITE : onBright
  const carries = (candidate: string) => contrast(onSurface, candidate) >= 4.5
  const away = onSurface === WHITE ? BLACK : WHITE
  const surface = barely(colour(), away, carries)
  const surfaceHover = barely(colour(), away, carries)
  const strong = barely(colour(), BLACK, (candidate) => contrast(WHITE, candidate) >= 4.5)
  const strongHover = mix(strong, BLACK, next() * 0.3)
  const deep = barely(colour(), BLACK, (candidate) => contrast(WHITE, candidate) >= 10)
  const bright = barely(colour(), WHITE, (candidate) => contrast(onBright, candidate) >= 4.5 && contrast(candidate, deep) >= 4.5 && luminance(candidate) > luminance(onBright))
  const tint = barely(colour(), WHITE, (candidate) => contrast(strong, candidate) >= 4.5 && luminance(candidate) > luminance(strong))
  return { surface, on_surface: onSurface, surface_hover: surfaceHover, strong, strong_hover: strongHover, deep, bright, tint, tint_border: colour(), on_strong: WHITE, on_bright: onBright }
}

describe('the stylesheet and the mapping name the same properties', () => {
  it.each(TOKEN_SETS)('%s: every brand-coloured token of the set reads its own property, and no other token does', (set) => {
    const expected = Object.fromEntries(
      BRAND_TOKEN_NAMES[set]
        // The dark scheme's emphasis tile is declared on the root, not in the `theme-dark` utility (below).
        .filter((token) => !(set === 'dark' && token === 'emphasis'))
        .map((token) => [token, brandVariable(set, token)]),
    )
    expect(brandProperties(block(SET_HEADERS[set]))).toEqual(expected)
  })

  it('the dark scheme’s emphasis tile reads the dark set’s property', () => {
    expect(brandProperties(block(DARK_SCHEME_ROOT))).toEqual({ emphasis: brandVariable('dark', 'emphasis') })
    expect(darkSchemeEmphasis).toBe('#0f3b3f')
  })

  it('no other block of the stylesheet reads a brand property', () => {
    const declared = [...Object.values(SET_HEADERS).map((header) => block(header)), block(DARK_SCHEME_ROOT)].join('\n')
    expect([...declared.matchAll(/var\(--brand-/g)].length).toBe(BRAND_VARIABLE_NAMES.length)
    // `theme-shell` applies the deep shell in the dark scheme by `@apply`, never by repeating its properties.
    expect(new Set(BRAND_VARIABLE_NAMES).size).toBe(BRAND_VARIABLE_NAMES.length)
    // And nowhere else in the stylesheet (its comments aside).
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect([...rules.matchAll(/var\(--brand-/g)].length).toBe(BRAND_VARIABLE_NAMES.length)
  })

  it('the coloured shell takes its scheme from the brand, and nothing on it is a fixed white', () => {
    const shellBlock = block(SET_HEADERS.shell)
    expect(shellBlock).toContain(`color-scheme: var(${SHELL_SCHEME_VARIABLE}, dark);`)
    // Every colour of the shell that is not a brand property is no colour at all, or an alias of one that is.
    const fixed = [...shellBlock.matchAll(/--color-([\w-]+):\s*([^;]+);/g)].filter(([, , value]) => !value!.startsWith('var(--brand-'))
    expect(Object.fromEntries(fixed.map(([, token, value]) => [token, value]))).toEqual({
      'accent-edge': 'transparent',
      'accent-strong': 'var(--color-accent)',
      'accent-strong-hover': 'var(--color-accent-hover)',
    })
    // The deep shell is dark whatever the brand: it says its scheme, its edge and the user's tile itself.
    const deepBlock = block(SET_HEADERS.deep)
    expect(deepBlock).toContain('color-scheme: dark;')
    expect(deepBlock).toContain('--color-shell-edge: transparent;')
    expect(Object.keys(brandProperties(deepBlock))).toEqual(expect.arrayContaining(['highlight', 'on-highlight']))
  })

  it('the neutral surfaces the mapping computes against are the stylesheet’s', () => {
    for (const [token, value] of Object.entries(NEUTRALS.light)) expect(light[token], `light ${token}`).toBe(value)
    for (const [token, value] of Object.entries(NEUTRALS.dark)) expect(dark[token], `dark ${token}`).toBe(value)
    expect(shell['danger-text']).toBe(NEUTRALS.shell['danger-text'])
    expect(deepShell['danger-text']).toBe(NEUTRALS.deep['danger-text'])
    expect(DEFAULT_THEME_COLORS).toEqual({ light: shell.shell, dark: deepShell.shell })
  })

  it('without a brand, a mark on the content area is the accent it always was', () => {
    expect(light['accent-strong']).toBe(light.accent)
    expect(light['accent-strong-hover']).toBe(light['accent-hover'])
    expect(css).toMatch(/--color-accent-edge: var\(--brand-light-accent-edge, transparent\);/)
    expect(css).toMatch(/--color-shell-edge: transparent;/)
    // On the dark surfaces the accent is fill and mark at once: an alias, and no edge.
    const darkBlock = block(SET_HEADERS.dark)
    expect(darkBlock).toContain('--color-accent-strong: var(--color-accent);')
    expect(darkBlock).toContain('--color-accent-strong-hover: var(--color-accent-hover);')
    expect(darkBlock).toContain('--color-accent-edge: transparent;')
  })

  it('while a page’s colours are replaced, the stylesheet switches every transition off', () => {
    // `applyDocumentIdentity` puts the attribute on the root for two frames (`document.test.ts`); this is its other half.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const selector = `:root[${IDENTITY_CHANGE_ATTRIBUTE}]`
    const start = rules.indexOf(`${selector} *,`)
    expect(start).toBeGreaterThan(-1)
    const rule = rules.slice(start, rules.indexOf('}', start) + 1).replace(/\s+/g, ' ')
    expect(rule).toBe(`${selector} *, ${selector} *::before, ${selector} *::after { transition: none !important; }`)
  })
})

/**
 * The server's own palettes (`src/test/serverPalettes.json`): what the backend's derivation
 * (`app.core.palette.derive_palette`, algorithm `oklch-2`) answers for the named colours, a ramp of
 * greys and a grid of 6 steps a channel, written out with the backend's interpreter. The other
 * fixtures here are stand-ins; these are the palettes the app really receives.
 */
const SERVER_PALETTES: [string, BrandPalette][] = Object.entries(serverPalettes.palettes).map(([colour, values]) => [
  colour,
  Object.fromEntries(serverPalettes.roles.map((role, index) => [role, values[index]])) as unknown as BrandPalette,
])

/** The tokens of one of the server's palettes, by its colour. */
function serverTokens(colour: string) {
  return brandTokens(SERVER_PALETTES.find(([key]) => key === colour)![1])
}

describe('the server’s own palettes keep every pair accessible', () => {
  it('the fixture holds the palettes of the algorithm this mapping was checked with, for the awkward colours too', () => {
    expect(serverPalettes.algorithm).toBe('oklch-2')
    expect(serverPalettes.roles).toEqual(['surface', 'on_surface', 'surface_hover', 'strong', 'strong_hover', 'deep', 'bright', 'tint', 'tint_border', 'on_strong', 'on_bright'])
    expect(SERVER_PALETTES.length).toBeGreaterThanOrEqual(250)
    const covered = new Set(SERVER_PALETTES.map(([colour]) => colour))
    expect(Object.values(SAMPLE_COLOURS).filter((colour) => !covered.has(colour))).toEqual([])
    for (const [, palette] of SERVER_PALETTES) for (const value of Object.values(palette)) expect(value).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('each one passes the check a brand goes through before it is used', () => {
    expect(SERVER_PALETTES.flatMap(([colour, palette]) => paletteProblems(palette).map((problem) => `${colour}: ${problem}`))).toEqual([])
  })

  it('each one keeps every text, boundary and focus pair, in the four token sets', () => {
    expect(SERVER_PALETTES.flatMap(([colour, palette]) => failuresOf(palette).map((failure) => `${colour}: ${failure}`))).toEqual([])
  })

  it('each one’s hover step is the server’s own: it shows on every surface, so none is computed here', () => {
    // `oklch-2` keeps the step 0.06 of OKLCH lightness from its surface (B12-21); the computed step is for a palette from before.
    expect(SERVER_PALETTES.filter(([, palette]) => brandTokens(palette).light['accent-hover'] !== palette.surface_hover).map(([colour]) => colour)).toEqual([])
  })

  it('both kinds of shell are among them: dark surfaces under white, light ones under the dark ink', () => {
    const lightSurfaces = SERVER_PALETTES.filter(([, palette]) => isLightSurface(palette))
    const darkSurfaces = SERVER_PALETTES.filter(([, palette]) => !isLightSurface(palette))
    expect(lightSurfaces.length).toBeGreaterThanOrEqual(80)
    expect(darkSurfaces.length).toBeGreaterThanOrEqual(80)
    // The shell's pairs alone, per kind: what the two tests above already hold, counted apart.
    for (const group of [lightSurfaces, darkSurfaces]) {
      expect(group.flatMap(([colour, palette]) => shellFailures(tokenSets(palette).shell).map((failure) => `${colour}: ${failure}`))).toEqual([])
    }
    // A light company colour is its own surface; a dark one too; only a mid-tone is the darkened step.
    for (const [colour, palette] of lightSurfaces) expect(palette.surface, `${colour}`).toBe(colour)
    for (const [colour, palette] of darkSurfaces) expect(palette.surface, `${colour}`).toBe(palette.strong)
  })

  it.each(['yellow', 'amber', 'pastel', 'neon', 'white', 'veryLight', 'sky'] as const)('%s is itself on its surfaces, under dark ink', (name) => {
    const colour = SAMPLE_COLOURS[name]
    const palette = SERVER_PALETTES.find(([key]) => key === colour)![1]
    const tokens = brandTokens(palette)
    expect(palette.surface).toBe(colour)
    expect(palette.on_surface).toBe(palette.on_bright)
    // The shell and the primary buttons are the colour itself; the browser's chrome follows the shell.
    expect(tokens.shell.shell).toBe(colour)
    expect(tokens.light.accent).toBe(colour)
    expect(tokens.light['on-accent']).toBe(palette.on_surface)
    expect(tokens.light['accent-hover']).toBe(palette.surface_hover)
    expect(themeColors(palette).light).toBe(colour)
    expect(tokens.shellScheme).toBe('light')
    // Everything drawn on the shell follows its ink: texts, the current page, the focus ring, the user's tile.
    for (const token of ['fg', 'fg-secondary', 'fg-muted', 'accent', 'accent-text', 'focus', 'neutral-text', 'highlight'] as const) expect(tokens.shell[token], `${token}`).toBe(palette.on_surface)
    expect(tokens.shell['on-accent']).toBe(colour)
    expect(tokens.shell['on-highlight']).toBe(colour)
    // Dividers and outlines are the ink laid over the surface, never white.
    const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(palette.on_surface.slice(index, index + 2), 16))
    expect(tokens.shell.border).toBe(`rgb(${r} ${g} ${b} / 0.22)`)
    expect(tokens.shell['border-subtle']).toBe(`rgb(${r} ${g} ${b} / 0.14)`)
    expect(tokens.shell['accent-border']).toBe(`rgb(${r} ${g} ${b} / 0.3)`)
    // Text, links and marks on the content area keep the darker step, which reads on white.
    expect(tokens.light['accent-text']).not.toBe(colour)
    expect(contrast(tokens.light['accent-text'], WHITE)).toBeGreaterThanOrEqual(TEXT)
    expect(contrast(tokens.light['accent-strong'], WHITE)).toBeGreaterThanOrEqual(UI)
    // The dark colour scheme and the dark reception screen keep the deep and bright steps.
    expect(tokens.deep.shell).toBe(palette.deep)
    expect(tokens.deep.accent).toBe(palette.bright)
    expect(tokens.deep.highlight).toBe(tokens.light.highlight)
    expect(themeColors(palette).dark).toBe(palette.deep)
  })

  it.each(['grey', 'midGrey', 'signalRed'] as const)('%s, on which neither ink reads, has the darkened step as its surface, under white', (name) => {
    const colour = SAMPLE_COLOURS[name]
    const palette = SERVER_PALETTES.find(([key]) => key === colour)![1]
    const tokens = brandTokens(palette)
    expect(contrast(WHITE, colour)).toBeLessThan(TEXT)
    expect(contrast(palette.on_bright, colour)).toBeLessThan(TEXT)
    expect(palette.surface).toBe(palette.strong)
    expect(palette.surface).not.toBe(colour)
    expect(palette.on_surface).toBe(WHITE)
    expect(tokens.shell.shell).toBe(palette.strong)
    expect(tokens.shell.fg).toBe(WHITE)
    expect(tokens.shellScheme).toBe('dark')
  })

  it('a dark colour is drawn as before: white on the colour, the current page a white pill', () => {
    for (const name of ['teal', 'darkBlue', 'red', 'purple', 'brown', 'black'] as const) {
      const colour = SAMPLE_COLOURS[name]
      const palette = SERVER_PALETTES.find(([key]) => key === colour)![1]
      const tokens = brandTokens(palette)
      expect(tokens.shell.shell, `${name}`).toBe(colour)
      expect(tokens.light.accent, `${name}`).toBe(colour)
      expect(tokens.light['on-accent'], `${name}`).toBe(WHITE)
      for (const token of ['fg', 'accent', 'focus', 'accent-text'] as const) expect(tokens.shell[token], `${name} ${token}`).toBe(WHITE)
      expect(tokens.shell['on-accent'], `${name}`).toBe(colour)
      expect(tokens.shell.border, `${name}`).toBe('rgb(255 255 255 / 0.22)')
      expect(tokens.shell.highlight, `${name}`).toBe(tokens.light.highlight)
      expect(tokens.shell['shell-edge'], `${name}`).toBe(NONE)
      expect(tokens.light['accent-edge'], `${name}`).toBe(NONE)
      expect(tokens.shellScheme, `${name}`).toBe('dark')
    }
  })

  it('a shell that would blend into the canvas ends at a line, and a button that would blend into its card has an edge', () => {
    for (const colour of [SAMPLE_COLOURS.white, SAMPLE_COLOURS.veryLight, '#fafafa']) {
      const tokens = serverTokens(colour)
      expect(tokens.shell['shell-edge'], `${colour}`).toMatch(/^rgb\(\d+ \d+ \d+ \/ 0\.16\)$/)
      expect(tokens.light['accent-edge'], `${colour}`).toBe(tokens.light['on-accent'])
      expect(contrast(tokens.light['accent-edge'], tokens.light.accent)).toBeGreaterThanOrEqual(UI)
    }
    // A colour that stands off the canvas by itself needs neither: a yellow, a pastel, a neon green.
    for (const colour of [SAMPLE_COLOURS.yellow, SAMPLE_COLOURS.pastel, SAMPLE_COLOURS.neon, SAMPLE_COLOURS.sky]) {
      const tokens = serverTokens(colour)
      expect(tokens.shell['shell-edge'], `${colour}`).toBe(NONE)
      expect(tokens.light['accent-edge'], `${colour}`).toBe(NONE)
    }
  })

  it('the cards, hover fills and menus of a shell can be told from it, whichever its kind', () => {
    const failed: string[] = []
    for (const [colour, palette] of SERVER_PALETTES) {
      const tokens = brandTokens(palette).shell
      const tell = (a: string, b: string, what: string) => {
        if (contrast(a, b) < 1.1) failed.push(`${colour}: ${what} ${a} on ${b}`)
      }
      tell(tokens.surface, tokens.shell, 'the user block')
      tell(over(tokens['surface-muted'], tokens.shell), tokens.shell, 'a hovered item')
      tell(over(tokens['surface-muted'], tokens.surface), tokens.surface, 'the hovered user block')
      tell(over(tokens['surface-muted'], tokens['surface-raised']), tokens['surface-raised'], 'a hovered menu item')
    }
    expect(failed).toEqual([])
  })

  it('a light shell shows a pointer by its ink laid thinly over it, a dark one by a darker step', () => {
    const yellow = serverTokens(SAMPLE_COLOURS.yellow).shell
    expect(yellow['surface-muted']).toBe('rgb(28 38 43 / 0.1)')
    expect(serverTokens(SAMPLE_COLOURS.white).shell['surface-muted']).toBe('rgb(28 38 43 / 0.1)')
    expect(serverTokens(SAMPLE_COLOURS.darkBlue).shell['surface-muted']).toMatch(/^#[0-9a-f]{6}$/)
    // Where the ink only just reads on a light surface, the veil would take the text below 4.5:1: a solid step there.
    const veiled = SERVER_PALETTES.filter(([, palette]) => isLightSurface(palette)).map(([colour]) => [colour, serverTokens(colour).shell['surface-muted']] as const)
    expect(veiled.filter(([, hover]) => hover.startsWith('rgb(')).length).toBeGreaterThan(veiled.length / 2)
    expect(veiled.filter(([, hover]) => hover.startsWith('#')).length).toBeGreaterThan(0)
  })
})

describe('a company’s palette keeps every pair accessible', () => {
  it.each(Object.entries(SAMPLE_COLOURS))('%s (%s)', (_name, colour) => {
    const palette = referencePalette(colour)
    // The fixture keeps the contract's guarantees, as the backend's palette does.
    expect(paletteProblems(palette)).toEqual([])
    expect(failuresOf(palette)).toEqual([])
  })

  it('across the colour cube (a grid of 9 steps a channel)', () => {
    const steps = [0, 32, 64, 96, 128, 160, 192, 224, 255]
    const failed: string[] = []
    for (const r of steps) {
      for (const g of steps) {
        for (const b of steps) {
          const colour = toHex([r, g, b])
          const palette = referencePalette(colour)
          const problems = [...paletteProblems(palette), ...failuresOf(palette)]
          if (problems.length > 0) failed.push(`${colour}: ${problems.join('; ')}`)
        }
      }
    }
    expect(failed).toEqual([])
  })

  it('for palettes that only just keep the guarantees, each role a hue of its own', () => {
    const next = random(20261013)
    const failed: string[] = []
    for (let index = 0; index < 3000; index += 1) {
      const palette = minimalPalette(next)
      expect(paletteProblems(palette)).toEqual([])
      const problems = failuresOf(palette)
      if (problems.length > 0) failed.push(`${JSON.stringify(palette)}: ${problems.join('; ')}`)
    }
    expect(failed.slice(0, 5)).toEqual([])
  })

  it('uses the palette’s own roles where they read: the brand’s colour is not washed out', () => {
    const palette = referencePalette(SAMPLE_COLOURS.darkBlue)
    const tokens = brandTokens(palette)
    expect(tokens.light.accent).toBe(palette.surface)
    expect(tokens.light.shell).toBe(palette.surface)
    expect(tokens.light['accent-hover']).toBe(palette.surface_hover)
    expect(tokens.light['on-accent']).toBe(palette.on_surface)
    expect(tokens.light['accent-strong']).toBe(palette.strong)
    expect(tokens.light['accent-strong-hover']).toBe(palette.strong_hover)
    expect(tokens.light['accent-text']).toBe(palette.strong)
    expect(tokens.light.focus).toBe(palette.strong)
    expect(tokens.light['accent-surface']).toBe(palette.tint)
    expect(tokens.light.selection).toBe(palette.bright)
    expect(tokens.light['chart-1']).toBe(palette.strong)
    expect(tokens.dark.accent).toBe(palette.bright)
    expect(tokens.dark['on-accent']).toBe(palette.on_bright)
    expect(tokens.dark.emphasis).toBe(palette.deep)
    expect(tokens.shell.shell).toBe(palette.surface)
    expect(tokens.shell.surface).toBe(palette.surface_hover)
    expect(tokens.shell['on-accent']).toBe(palette.surface)
    expect(tokens.shell.accent).toBe(palette.on_surface)
    expect(tokens.deep.shell).toBe(palette.deep)
    expect(tokens.deep.accent).toBe(palette.bright)
    // The bright step, or a lighter one where the deep shell's cards need it.
    expect(contrast(tokens.deep['accent-text'], palette.deep)).toBeGreaterThanOrEqual(contrast(palette.bright, palette.deep))
  })

  it('takes a darker role for coloured text where `strong` does not read on the grey canvas', () => {
    // The product's own teal: white on it 4.70:1, but on the canvas it is 4.16:1.
    const palette = referencePalette(SAMPLE_COLOURS.teal)
    const tokens = brandTokens(palette)
    expect(contrast(palette.strong, light.canvas!)).toBeLessThan(TEXT)
    expect(tokens.light['accent-text']).toBe(palette.strong_hover)
    // A ring and a chart mark need 3:1 only: they keep the brand's own colour.
    expect(tokens.light.focus).toBe(palette.strong)
  })

  it('gives a black brand a hover and shell cards that show', () => {
    const palette = referencePalette(SAMPLE_COLOURS.black)
    const tokens = brandTokens(palette)
    expect(tokens.light.accent).toBe('#000000')
    expect(contrast(tokens.light['accent-hover'], tokens.light.accent)).toBeGreaterThanOrEqual(1.12)
    expect(contrast(tokens.shell.surface, tokens.shell.shell)).toBeGreaterThanOrEqual(1.12)
    expect(contrast(tokens.shell['surface-muted'], tokens.shell.surface)).toBeGreaterThanOrEqual(1.12)
  })
})

/** The part of a `CSSStyleDeclaration` the mapping uses. */
function fakeStyle() {
  const values = new Map<string, string>()
  const writes: string[] = []
  const style = {
    getPropertyValue: (name: string) => values.get(name) ?? '',
    setProperty: (name: string, value: string) => {
      writes.push(name)
      values.set(name, value)
    },
    removeProperty: (name: string) => {
      values.delete(name)
      return ''
    },
  } as unknown as CSSStyleDeclaration
  return { style, values, writes }
}

describe('the properties on an element', () => {
  it('sets every property of the four sets, and only those', () => {
    const { style, values } = fakeStyle()
    const tokens = brandTokens(referencePalette(SAMPLE_COLOURS.amber))
    applyBrandVariables(style, tokens)
    expect([...values.keys()].toSorted()).toEqual([...BRAND_VARIABLE_NAMES].toSorted())
    expect(values.get('--brand-light-accent')).toBe(tokens.light.accent)
    expect(values.get('--brand-deep-shell')).toBe(tokens.deep.shell)
    expect(values.get(SHELL_SCHEME_VARIABLE)).toBe('light')
    expect(Object.keys(brandVariables(tokens)).toSorted()).toEqual([...BRAND_VARIABLE_NAMES].toSorted())
    // A colour, the ink laid over a surface, no colour at all, or the shell's scheme: nothing else reaches the stylesheet.
    const written = [...values].filter(([name]) => name !== SHELL_SCHEME_VARIABLE)
    expect(written.filter(([, value]) => !/^(#[0-9a-f]{6}|rgb\(\d{1,3} \d{1,3} \d{1,3} \/ 0\.\d{1,2}\)|transparent)$/.test(value))).toEqual([])
    // Only the edges, the dividers and a light shell's hover veil are not plain colours.
    expect(written.filter(([, value]) => !value.startsWith('#')).map(([name]) => name).toSorted()).toEqual(
      ['--brand-light-accent-edge', '--brand-shell-accent-border', '--brand-shell-border', '--brand-shell-border-subtle', '--brand-shell-shell-edge', '--brand-shell-surface-muted'].toSorted(),
    )
  })

  it('writes nothing when the same palette is applied again', () => {
    const { style, writes } = fakeStyle()
    const tokens = brandTokens(referencePalette(SAMPLE_COLOURS.orange))
    applyBrandVariables(style, tokens)
    const first = writes.length
    applyBrandVariables(style, tokens)
    expect(writes.length).toBe(first)
  })

  it('removes them all without a palette: the stylesheet’s own colours apply again', () => {
    const { style, values } = fakeStyle()
    applyBrandVariables(style, brandTokens(referencePalette(SAMPLE_COLOURS.yellow)))
    applyBrandVariables(style, null)
    expect(values.size).toBe(0)
  })

  it('gives the browser’s chrome the shell’s colours', () => {
    const palette = referencePalette(SAMPLE_COLOURS.purple)
    expect(themeColors(palette)).toEqual({ light: palette.surface, dark: palette.deep })
    expect(themeColors(null)).toEqual({ light: '#188086', dark: '#0f3b3f' })
  })
})

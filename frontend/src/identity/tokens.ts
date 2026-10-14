import type { BrandPalette } from '../types/api'
import { isLightSurface } from './brand'
import { BLACK, contrast, distance, mix, toRgb, WHITE } from './colour'

/*
 * A company's palette on the app's design tokens (Phase 12).
 *
 * `index.css` has four sets of colour tokens that a brand colours: the light content area, the dark
 * surfaces (the dark colour scheme, the reception tablet), the coloured shell and the deep shell. Each
 * brand-coloured token there reads a custom property with the product's own colour as its fallback:
 *
 *   --color-accent: var(--brand-light-accent, #188086);
 *
 * `brandTokens` gives the value of every such property for a palette, and `applyBrandVariables` puts
 * them on an element through the CSSOM (the app's style policy is `style-src 'self'`: no style element
 * and no style attribute in markup). Without a palette nothing is set, and the stylesheet's own
 * colours stay.
 *
 * Text and background pairs use the palette's roles as the contract guarantees them: `on_surface` on
 * `surface` and `surface_hover`, white on `strong` and `strong_hover`, `on_bright` on `bright`,
 * `bright` on `deep`, `strong` on `tint` and on white. Where a role meets a surface the palette
 * knows nothing of (the grey canvas, the dark cards), the pair is computed here: the first role that
 * reads on every such surface is taken, and a colour is only ever moved in the direction that adds
 * contrast (towards white on dark surfaces, towards black on light ones). Steps in between (hover
 * fills, borders) are mixes.
 *
 * Brand surfaces (the shell, primary buttons) are `surface`: the company's own colour wherever
 * white or the dark ink reads on it, so a yellow company is yellow. Its ink (`on_surface`) is then
 * the dark one, and everything drawn on the shell follows it: texts and icons, the current page,
 * hover fills, dividers, the focus ring. `strong` stays the colour of text, links and marks on the
 * content area, where a yellow would not read.
 */

/** WCAG 2.2 AA: text 4.5:1; boundaries, indicators and focus rings 3:1. */
const TEXT = 4.5
const UI = 3

/**
 * The neutral surfaces and texts of `index.css` that brand colours meet. `tokens.test.ts` reads the
 * stylesheet and fails when a value here is not the stylesheet's.
 */
export const NEUTRALS = {
  light: {
    surface: '#ffffff',
    canvas: '#f1f1f1',
    'surface-muted': '#eef0f1',
    'surface-sunken': '#f8f8f8',
    'tab-track': '#e6e9eb',
    fg: '#1c262b',
    'fg-muted': '#4d616c',
    emphasis: '#1c262b',
    'danger-text': '#b4232a',
  },
  dark: {
    canvas: '#101619',
    surface: '#182126',
    'surface-muted': '#1f2a30',
    'surface-raised': '#1f2a30',
    'tab-track': '#1c272d',
    fg: '#eef2f4',
    'fg-muted': '#99a9b2',
  },
  shell: { 'danger-text': '#ffc9cb' },
  deep: { 'danger-text': '#ffb3b6' },
} as const

/** The tokens a brand colours, per set: exactly the `--brand-<set>-<token>` properties `index.css` reads. */
export const BRAND_TOKEN_NAMES = {
  light: [
    'shell',
    'accent',
    'accent-hover',
    'on-accent',
    'accent-edge',
    'accent-strong',
    'accent-strong-hover',
    'accent-surface',
    'accent-border',
    'accent-text',
    'focus',
    'selection',
    'on-selection',
    'highlight',
    'on-highlight',
    'row-highlight',
    'tab-indicator',
    'chart-1',
  ],
  dark: [
    'accent',
    'accent-hover',
    'on-accent',
    'accent-surface',
    'accent-border',
    'accent-text',
    'focus',
    'on-selection',
    'on-highlight',
    'row-highlight',
    'tab-selected',
    'on-tab-selected',
    'tab-indicator',
    'chart-1',
    'chart-2',
    'emphasis',
  ],
  shell: [
    'shell',
    'shell-edge',
    'surface',
    'surface-muted',
    'surface-sunken',
    'surface-raised',
    'border',
    'border-subtle',
    'border-strong',
    'fg',
    'fg-secondary',
    'fg-muted',
    'accent',
    'accent-hover',
    'on-accent',
    'accent-surface',
    'accent-border',
    'accent-text',
    'focus',
    'highlight',
    'on-highlight',
    'neutral-surface',
    'neutral-text',
    'danger-text',
  ],
  deep: [
    'shell',
    'surface',
    'surface-muted',
    'surface-sunken',
    'surface-raised',
    'border-strong',
    'fg-secondary',
    'fg-muted',
    'accent',
    'accent-hover',
    'on-accent',
    'accent-surface',
    'accent-text',
    'focus',
    'highlight',
    'on-highlight',
    'neutral-surface',
  ],
} as const

/**
 * What a brand sets beside its colours: whether the coloured shell is a light surface or a dark one
 * (`color-scheme` there: its scrollbars and the browser's own controls follow it).
 */
export const SHELL_SCHEME_VARIABLE = '--brand-shell-scheme'

export type TokenSet = keyof typeof BRAND_TOKEN_NAMES
export const TOKEN_SETS = Object.keys(BRAND_TOKEN_NAMES) as TokenSet[]

export type BrandTokens = { [Set in TokenSet]: Record<(typeof BRAND_TOKEN_NAMES)[Set][number], string> } & {
  /** The coloured shell as a surface: `light` under the dark ink, `dark` under white. */
  shellScheme: 'light' | 'dark'
}

/** No colour: a token that paints nothing (an edge a surface does not need). */
export const NONE = 'transparent'

const STEPS = 25

/**
 * `colour` when it passes; else the first of its steps towards `toward` that does (4 % at a time),
 * and `toward` itself at the end.
 */
function ensure(colour: string, passes: (candidate: string) => boolean, toward: string): string {
  if (passes(colour)) return colour
  for (let step = 1; step < STEPS; step += 1) {
    const candidate = mix(colour, toward, step / STEPS)
    if (passes(candidate)) return candidate
  }
  return toward
}

const readsOn = (backgrounds: readonly string[], minimum: number) => (candidate: string) => backgrounds.every((background) => contrast(candidate, background) >= minimum)

/** Two fills a person can tell apart when one lies on the other (a hover fill, a card on the shell). */
const apart = (a: string, b: string) => contrast(a, b) >= 1.12

/**
 * Two colours so close that one lying on the other has no visible edge (a white button on a white
 * card, a near-white shell beside the grey canvas). By distance, not by luminance: a pastel and a
 * grey of the same lightness are still two colours to the eye.
 */
const blends = (a: string, b: string) => distance(toRgb(a), toRgb(b)) < 40

/** How thinly the ink is laid over a light shell as its hover fill: the first share on which the ink still reads everywhere. */
const HOVER_VEILS = [0.1, 0.08] as const

/** `ink` laid over whatever is below it at `share`: a divider, an outline or a hover fill in the ink's direction. */
function overlay(ink: string, share: number): string {
  const [r, g, b] = toRgb(ink)
  return `rgb(${r} ${g} ${b} / ${share})`
}

/**
 * A step off a fill that lies under `ink`, which a person can tell from it (and from the `others`
 * it is seen beside) and on which the ink still reads: darker first (as a hover is), lighter where
 * a darker one would not show (black), would not carry the ink (a light surface that only just
 * does), or would come back to one of the others (the hover of a card that is itself the lighter
 * step of its shell).
 */
function stepOff(from: string, ink: string, amount: number, others: readonly string[] = []): string {
  const reads = readsOn([ink], TEXT)
  const shows = (candidate: string) => reads(candidate) && [from, ...others].every((other) => apart(candidate, other))
  for (const reach of [1, 1.6, 2.4]) {
    const darker = mix(from, BLACK, amount * reach)
    if (shows(darker)) return darker
    const lighter = mix(from, WHITE, (amount + 0.06) * reach)
    if (shows(lighter)) return lighter
  }
  return ensure(mix(from, WHITE, amount + 0.06), reads, from)
}

/** The hover and pressed step of a brand surface: the palette's own where it shows, else a computed one. */
function surfaceHover(palette: BrandPalette): string {
  return apart(palette.surface_hover, palette.surface) ? palette.surface_hover : stepOff(palette.surface, palette.on_surface, 0.14)
}

function lightTokens(palette: BrandPalette): BrandTokens['light'] {
  const light = NEUTRALS.light
  // The tint lies under slate text too (a chosen option, a selected row), not only under `strong`.
  const tint = ensure(palette.tint, readsOnBoth(light.fg, light['fg-muted']), WHITE)
  const rowHighlight = ensure(mix(tint, WHITE, 0.45), readsOnBoth(light.fg, light['fg-muted']), WHITE)
  const roles = [palette.strong, palette.strong_hover, palette.deep]
  // Links and coloured text also stand on the grey canvas and on the tint, which `strong` need not read on.
  const readable = readsOn([light.surface, light.canvas, light['surface-muted'], light['surface-sunken'], tint, rowHighlight], TEXT)
  const text = roles.find(readable) ?? ensure(palette.deep, readable, BLACK)
  const marks = readsOn([light.surface, light.canvas, light['tab-track']], UI)
  const mark = roles.find(marks) ?? ensure(palette.deep, marks, BLACK)
  // A hover that shows: the darker step, or a lighter one where the colour cannot get darker (black).
  const whiteReads = readsOn([WHITE], TEXT)
  const hover = apart(palette.strong_hover, palette.strong) ? palette.strong_hover : ensure(mix(palette.strong, WHITE, 0.18), whiteReads, palette.strong)
  return {
    shell: palette.surface,
    // Filled brand surfaces (primary buttons, a chosen segment): the company's own colour under its ink.
    accent: palette.surface,
    'accent-hover': surfaceHover(palette),
    'on-accent': palette.on_surface,
    // A fill that would vanish into a white card or the canvas (a white or near-white company) gets an edge in its ink.
    'accent-edge': blends(palette.surface, light.surface) || blends(palette.surface, light.canvas) ? palette.on_surface : NONE,
    // The brand as a line or a mark on the content area (a chosen option's border, a meter, a native checkbox): 3:1.
    'accent-strong': mark,
    'accent-strong-hover': hover,
    'accent-surface': tint,
    'accent-border': palette.tint_border,
    'accent-text': text,
    focus: mark,
    selection: palette.bright,
    'on-selection': palette.on_bright,
    // The numeral of the dark emphasis tile (ink in the light scheme) is in the highlight colour.
    highlight: ensure(palette.bright, readsOn([light.emphasis], TEXT), WHITE),
    'on-highlight': palette.on_bright,
    'row-highlight': rowHighlight,
    'tab-indicator': mark,
    'chart-1': mark,
  }
}

/** A background on which both texts read. */
function readsOnBoth(text: string, mutedText: string) {
  return (background: string) => contrast(text, background) >= TEXT && contrast(mutedText, background) >= TEXT
}

function darkTokens(palette: BrandPalette): BrandTokens['dark'] {
  const dark = NEUTRALS.dark
  // The deep step as a surface of its own (a chosen option, the emphasis tile): the dark set's texts read on it.
  const deepSurface = ensure(palette.deep, readsOnBoth(dark.fg, dark['fg-muted']), BLACK)
  const accent = ensure(palette.bright, readsOn([dark.surface, dark.canvas, dark['surface-muted'], dark['surface-raised'], dark['tab-track']], UI), WHITE)
  const rowHighlight = ensure(mix(deepSurface, dark.surface, 0.5), readsOnBoth(dark.fg, dark['fg-muted']), BLACK)
  const text = ensure(accent, readsOn([dark.surface, dark.canvas, dark['surface-muted'], dark['surface-raised'], deepSurface, rowHighlight], TEXT), WHITE)
  return {
    accent,
    'accent-hover': mix(accent, WHITE, 0.25),
    'on-accent': palette.on_bright,
    'accent-surface': deepSurface,
    'accent-border': mix(accent, deepSurface, 0.6),
    'accent-text': text,
    focus: accent,
    'on-selection': palette.on_bright,
    'on-highlight': palette.on_bright,
    'row-highlight': rowHighlight,
    'tab-selected': accent,
    'on-tab-selected': palette.on_bright,
    'tab-indicator': accent,
    'chart-1': accent,
    'chart-2': mix(accent, WHITE, 0.3),
    emphasis: deepSurface,
  }
}

/**
 * The coloured shell (the sidebar, the phone's top bar and drawer, the head of a pass): `surface`
 * under its ink. A dark surface is drawn as before: white texts, darker steps as its cards, the
 * current page a white pill. A light one (a yellow, a pastel, white) is its mirror: everything on it
 * is the dark ink, the current page an ink pill with the surface's colour as its text, the dividers
 * and the focus ring ink too, since white would not show on it.
 */
function shellTokens(palette: BrandPalette, highlight: string): BrandTokens['shell'] {
  const base = palette.surface
  const ink = palette.on_surface
  const light = isLightSurface(palette)
  const inkReads = readsOn([ink], TEXT)
  const step = (from: string, amount: number) => stepOff(from, ink, amount)
  // The shell's cards (the user block, the language switch): the palette's own hover step where it shows.
  const surface = apart(palette.surface_hover, base) && inkReads(palette.surface_hover) ? palette.surface_hover : step(base, 0.14)
  // Menus opened from the shell: a deeper step of a dark shell, a near-white one of a light shell.
  const dangerText = light ? NEUTRALS.light['danger-text'] : NEUTRALS.shell['danger-text']
  const menu = (candidate: string) => inkReads(candidate) && contrast(dangerText, candidate) >= TEXT
  const raised = light ? ensure(mix(base, WHITE, 0.86), menu, WHITE) : ensure(step(surface, 0.26), menu, BLACK)
  // An outline that shows on the shell (the language switch, a field): 3:1.
  const outlines = readsOn([base], UI)
  const outline = !light && outlines(palette.tint) ? palette.tint : ensure(mix(base, ink, 0.6), outlines, ink)
  // The hover fill lies on the shell itself (an item), on its cards (the user block) and on its menus.
  // On a dark shell it is one more darker step, as before. On a light one it is the ink laid thinly
  // over whichever of the three is below, as light surfaces show a pointer: a solid step dark enough
  // to show on the shell is a heavy block on the near-white menu. Only where the ink would then no
  // longer read on it (a surface that just carries the ink) is it a solid step there too.
  const solidHover = stepOff(surface, ink, 0.14, [base, raised])
  const veil = light ? HOVER_VEILS.find((share) => [base, surface, raised].every((under) => inkReads(mix(under, ink, share)))) : undefined
  // The current page's pill is the ink itself, and its text the surface's colour, which the ink reads on.
  const baseReads = readsOn([base], TEXT)
  const pillHover = !light && baseReads(palette.tint) ? palette.tint : ensure(mix(ink, base, 0.14), baseReads, ink)
  return {
    shell: base,
    // Beside the grey canvas a near-white shell needs a line to end at.
    'shell-edge': blends(base, NEUTRALS.light.canvas) ? overlay(ink, 0.16) : NONE,
    surface,
    'surface-muted': veil === undefined ? solidHover : overlay(ink, veil),
    'surface-sunken': mix(base, surface, 0.5),
    'surface-raised': raised,
    border: overlay(ink, 0.22),
    'border-subtle': overlay(ink, 0.14),
    'border-strong': outline,
    fg: ink,
    'fg-secondary': ink,
    'fg-muted': ink,
    accent: ink,
    'accent-hover': pillHover,
    'on-accent': base,
    'accent-surface': surface,
    'accent-border': overlay(ink, 0.3),
    'accent-text': ink,
    focus: ink,
    // The signed-in user's tile: the bright step on a dark shell; on a light one the ink, like the current page.
    highlight: light ? ink : highlight,
    'on-highlight': light ? base : palette.on_bright,
    'neutral-surface': raised,
    'neutral-text': ink,
    'danger-text': dangerText,
  }
}

function deepTokens(palette: BrandPalette, highlight: string): BrandTokens['deep'] {
  const deep = palette.deep
  // Lighter steps of the deep colour for its cards, hover fills and menus; white keeps 7:1 on each.
  const whiteReads = readsOn([WHITE], 7)
  const surface = ensure(mix(deep, WHITE, 0.1), whiteReads, deep)
  const hover = ensure(mix(deep, WHITE, 0.07), whiteReads, deep)
  const raised = ensure(mix(deep, WHITE, 0.05), (candidate) => whiteReads(candidate) && contrast(NEUTRALS.deep['danger-text'], candidate) >= TEXT, deep)
  const fills = [deep, surface, hover, raised]
  const soft = (share: number) => ensure(mix(WHITE, deep, share), readsOn(fills, TEXT), WHITE)
  return {
    shell: deep,
    surface,
    'surface-muted': hover,
    'surface-sunken': mix(deep, BLACK, 0.12),
    'surface-raised': raised,
    'border-strong': ensure(mix(palette.bright, deep, 0.4), readsOn([deep], UI), palette.bright),
    'fg-secondary': soft(0.14),
    'fg-muted': soft(0.24),
    accent: palette.bright,
    'accent-hover': mix(palette.bright, WHITE, 0.25),
    'on-accent': palette.on_bright,
    'accent-surface': surface,
    'accent-text': ensure(palette.bright, readsOn(fills, TEXT), WHITE),
    focus: palette.bright,
    // The signed-in user's tile, as on every dark surface (a light shell's ink tile must not reach here).
    highlight,
    'on-highlight': palette.on_bright,
    'neutral-surface': raised,
  }
}

/** Every brand-coloured token of the four sets, for a palette that keeps the contract's guarantees. */
export function brandTokens(palette: BrandPalette): BrandTokens {
  const light = lightTokens(palette)
  return {
    light,
    dark: darkTokens(palette),
    shell: shellTokens(palette, light.highlight),
    deep: deepTokens(palette, light.highlight),
    shellScheme: isLightSurface(palette) ? 'light' : 'dark',
  }
}

/** The custom property `index.css` reads for a token of a set. */
export function brandVariable(set: TokenSet, token: string): string {
  return `--brand-${set}-${token}`
}

/** Every `--brand-…` property with its value. */
export function brandVariables(tokens: BrandTokens): Record<string, string> {
  const variables: Record<string, string> = { [SHELL_SCHEME_VARIABLE]: tokens.shellScheme }
  for (const set of TOKEN_SETS) {
    for (const [token, value] of Object.entries(tokens[set])) variables[brandVariable(set, token)] = value
  }
  return variables
}

/** The name of every `--brand-…` property. */
export const BRAND_VARIABLE_NAMES: readonly string[] = [...TOKEN_SETS.flatMap((set) => BRAND_TOKEN_NAMES[set].map((token) => brandVariable(set, token))), SHELL_SCHEME_VARIABLE]

/**
 * Puts a palette's properties on an element (the document's root for the app, a wrapper for a
 * preview), or removes them all: the stylesheet's own colours then apply again. Answers whether
 * anything changed.
 */
export function applyBrandVariables(style: CSSStyleDeclaration, tokens: BrandTokens | null): boolean {
  const variables = tokens ? brandVariables(tokens) : {}
  let changed = false
  for (const name of BRAND_VARIABLE_NAMES) {
    const value = variables[name]
    const current = style.getPropertyValue(name)
    if (value === undefined) {
      if (current === '') continue
      style.removeProperty(name)
    } else {
      if (current === value) continue
      style.setProperty(name, value)
    }
    changed = true
  }
  return changed
}

/**
 * The colours of a page whose company is still on its way (a first visit on a slow connection):
 * nobody's. The slate of the app's own text, so the primary button, the links and a pass's head
 * are neutral until the company's colours arrive; the page never shows the product's teal first and
 * the company's colour after it. A palette like any other: it keeps the contract's guarantees.
 */
export const PENDING_PALETTE: BrandPalette = {
  surface: '#33444e',
  on_surface: '#ffffff',
  surface_hover: '#1c262b',
  strong: '#33444e',
  strong_hover: '#1c262b',
  deep: '#1c262b',
  bright: '#c3ced5',
  tint: '#eef1f2',
  tint_border: '#d3dadd',
  on_strong: '#ffffff',
  on_bright: '#1c262b',
}

/** The browser's own chrome around the page (`theme-color`): the coloured shell, and the deep one in the dark scheme. */
export const DEFAULT_THEME_COLORS = { light: '#188086', dark: '#0f3b3f' } as const

/**
 * The browser's chrome in the platform owner's area: its own shell (`theme-shell-platform`), the deep
 * teal, and the slate in the dark scheme. Not the companies' teal, which a neutral page takes.
 */
export const PLATFORM_THEME_COLORS = { light: '#0f3b3f', dark: '#33444e' } as const

export function themeColors(palette: BrandPalette | null): { light: string; dark: string } {
  return palette ? { light: palette.surface, dark: palette.deep } : DEFAULT_THEME_COLORS
}

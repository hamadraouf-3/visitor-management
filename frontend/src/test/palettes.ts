// With their extensions: the mocked E2E specs import this module too, and Node resolves no bare paths.
import { BLACK, contrast, mix, toHsl, toHex, WHITE } from '../identity/colour.ts'
import type { BrandPalette, CompanyBrand } from '../types/api.ts'

/*
 * Palettes for tests and mocked API responses (Phase 12). The backend alone derives a company's
 * palette; `referencePalette` is a stand-in that keeps the contract's guarantees for any colour, so
 * tests and layout checks have realistic palettes without the API. It is not the backend's
 * algorithm, and nothing in the app calls it.
 */

function fromHsl(hue: number, saturation: number, lightness: number): string {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const sector = (((hue % 360) + 360) % 360) / 60
  const x = chroma * (1 - Math.abs((sector % 2) - 1))
  const [r, g, b] = sector < 1 ? [chroma, x, 0] : sector < 2 ? [x, chroma, 0] : sector < 3 ? [0, chroma, x] : sector < 4 ? [0, x, chroma] : sector < 5 ? [x, 0, chroma] : [chroma, 0, x]
  const m = lightness - chroma / 2
  return toHex([(r + m) * 255, (g + m) * 255, (b + m) * 255])
}

/** The colour's hue at lightness `from`, stepped by `step` until `passes`. */
function stepLightness(hue: number, saturation: number, from: number, step: number, passes: (colour: string) => boolean): string {
  for (let lightness = from; lightness >= 0 && lightness <= 1; lightness += step) {
    const colour = fromHsl(hue, saturation, Math.min(1, Math.max(0, lightness)))
    if (passes(colour)) return colour
  }
  return step < 0 ? BLACK : WHITE
}

/** The product's dark ink, as the server's palettes have it. */
const ON_BRIGHT = '#1c262b'

/**
 * What brand surfaces are painted with, for a colour and the `strong` steps derived from it: the
 * colour itself wherever white or the dark ink reads on it (4.5:1), with a step that shows as its
 * hover; `strong` under white for a mid-tone on which neither reads.
 */
export function referenceSurface(color: string, strong: string, strongHover: string, ink: string): Pick<BrandPalette, 'surface' | 'on_surface' | 'surface_hover'> {
  if (contrast(WHITE, color) >= 4.5) return { surface: color, on_surface: WHITE, surface_hover: color === strong ? strongHover : mix(color, BLACK, 0.14) }
  if (contrast(ink, color) < 4.5) return { surface: strong, on_surface: WHITE, surface_hover: strongHover }
  // A light surface: its hover is a darker step while the ink still reads on it, else a lighter one.
  const darker = mix(color, BLACK, 0.09)
  const hover = contrast(ink, darker) >= 4.5 ? darker : mix(color, WHITE, 0.3)
  return { surface: color, on_surface: ink, surface_hover: hover }
}

/** A palette for `color` (`#rrggbb`) that keeps every guarantee of the contract. */
export function referencePalette(color: string): BrandPalette {
  const { hue, saturation, lightness } = toHsl(color)
  const strong = contrast(WHITE, color) >= 4.5 ? color : stepLightness(hue, saturation, lightness, -0.005, (candidate) => contrast(WHITE, candidate) >= 4.5)
  const strongHsl = toHsl(strong)
  const strongHover = fromHsl(hue, strongHsl.saturation, Math.max(0, strongHsl.lightness - 0.06))
  const deep = stepLightness(hue, Math.min(saturation, 0.62), 0.16, -0.005, (candidate) => contrast(WHITE, candidate) >= 12)
  const bright = stepLightness(hue, saturation === 0 ? 0 : Math.max(saturation, 0.55), 0.58, 0.005, (candidate) => contrast(ON_BRIGHT, candidate) >= 6.5 && contrast(candidate, deep) >= 4.5)
  const tint = stepLightness(hue, Math.min(saturation, 0.45), 0.95, 0.005, (candidate) => contrast(strong, candidate) >= 4.5)
  return {
    ...referenceSurface(color, strong, strongHover, ON_BRIGHT),
    strong,
    strong_hover: strongHover,
    deep,
    bright,
    tint,
    tint_border: mix(tint, strong, 0.22),
    on_strong: WHITE,
    on_bright: ON_BRIGHT,
  }
}

/** Colours a company might pick, the awkward ones among them: yellow, black, white, a very light one, a grey, a neon. */
export const SAMPLE_COLOURS = {
  teal: '#188086',
  darkBlue: '#1e3a8a',
  orange: '#f97316',
  yellow: '#f7b916',
  black: '#000000',
  white: '#ffffff',
  veryLight: '#f5f0e6',
  grey: '#808080',
  neon: '#39ff14',
  red: '#e11d48',
  purple: '#7c3aed',
  brown: '#5b3a1e',
  // Light colours a company may well have: they are their own surface, under dark ink.
  pastel: '#f9c6d0',
  amber: '#f5b800',
  sky: '#7dd3fc',
  // Mid-tones on which neither white nor the ink reads: their surface is the darkened `strong`.
  midGrey: '#8a8a8a',
  signalRed: '#ff0000',
} as const

export type SampleColour = keyof typeof SAMPLE_COLOURS

/** A company's brand as the API sends it, for a slug: the files it has and its colour. */
export function makeBrand(
  slug: string,
  { color = null, logo = false, logoDark = false, icon = false, version = 'v1' }: { color?: string | null; logo?: boolean; logoDark?: boolean; icon?: boolean; version?: string } = {},
): CompanyBrand {
  const file = (kind: string) => `/api/v1/public/companies/${slug}/brand/${kind}.png?v=${version}`
  return {
    logo_url: logo ? file('logo') : null,
    logo_dark_url: logoDark ? file('logo_dark') : null,
    icon_url: icon ? file('icon') : null,
    color,
    palette: color ? referencePalette(color) : null,
    version,
  }
}

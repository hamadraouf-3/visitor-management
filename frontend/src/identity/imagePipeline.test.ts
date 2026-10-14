import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearFlatBackground,
  contentBounds,
  extractColours,
  fitIcon,
  fitLogo,
  ICON_LOGO_SHARE,
  iconFromLogo,
  ImagePipelineError,
  imageProblemOf,
  letterIcon,
  LOGO_LIMITS,
  LOGO_MAX_TALL,
  LOGO_MAX_WIDE,
  MAX_ASSET_BYTES,
  MAX_SOURCE_BYTES,
  MIN_SOURCE_SIDE,
  NEUTRAL_TILE,
  prepareIcon,
  prepareLogo,
  shapeProblem,
  toneProblem,
  toneShares,
  WORDMARK_MIN_RATIO,
  workingSize,
  type Raster,
} from './imagePipeline'

/*
 * A logo prepared in the browser (Phase 12): the geometry and the colours as pure functions, and the
 * canvas pipeline around them. jsdom has neither an image decoder nor a canvas, so the pipeline runs
 * on small fakes of both (below): a picture is a colour with an optional transparent margin, a
 * canvas a real grid of pixels, and "encoding" gives a blob whose size is the canvas's area times a
 * weight the test sets.
 */

type Rgba = readonly [number, number, number, number]

/* ---- pure: geometry ---------------------------------------------------------------------------- */

describe('a logo’s size', () => {
  it('keeps a picture inside the limits as it is', () => {
    expect(fitLogo(462, 149)).toEqual({ width: 462, height: 149, x: 0, y: 0, drawWidth: 462, drawHeight: 149 })
    expect(fitLogo(1200, 600)).toMatchObject({ width: 1200, height: 600 })
    expect(fitLogo(32, 32)).toMatchObject({ width: 32, height: 32 })
  })

  it('makes a larger picture smaller, its proportions kept', () => {
    expect(fitLogo(2400, 800)).toMatchObject({ width: 1200, height: 400, drawWidth: 1200, drawHeight: 400 })
    // A tall one is held by its height.
    expect(fitLogo(1000, 2000)).toMatchObject({ width: 300, height: 600 })
    expect(fitLogo(4000, 4000)).toMatchObject({ width: 600, height: 600 })
  })

  it('enlarges a picture that is too small as far as the limits allow', () => {
    expect(fitLogo(16, 16)).toMatchObject({ width: 32, height: 32, drawWidth: 32, drawHeight: 32 })
    expect(fitLogo(200, 20)).toMatchObject({ width: 320, height: 32, drawWidth: 320, drawHeight: 32 })
    expect(fitLogo(10, 100)).toMatchObject({ width: 32, height: 320 })
  })

  it('gives a very long, thin picture transparent room on its short side, centred', () => {
    // 1200 × 12: the width is at its limit, so the height cannot grow to 32.
    expect(fitLogo(2400, 24)).toEqual({ width: 1200, height: 32, x: 0, y: 10, drawWidth: 1200, drawHeight: 12 })
    expect(fitLogo(10, 1000)).toEqual({ width: 32, height: 600, x: 13, y: 0, drawWidth: 6, drawHeight: 600 })
  })

  it('always answers inside the contract’s limits', () => {
    for (const width of [1, 7, 31, 32, 33, 500, 1199, 1200, 1201, 5000, 40_000]) {
      for (const height of [1, 7, 31, 32, 33, 300, 599, 600, 601, 5000, 40_000]) {
        const placed = fitLogo(width, height)
        expect(placed.width).toBeGreaterThanOrEqual(LOGO_LIMITS.minWidth)
        expect(placed.width).toBeLessThanOrEqual(LOGO_LIMITS.maxWidth)
        expect(placed.height).toBeGreaterThanOrEqual(LOGO_LIMITS.minHeight)
        expect(placed.height).toBeLessThanOrEqual(LOGO_LIMITS.maxHeight)
        // The picture lies on its canvas.
        expect(placed.x).toBeGreaterThanOrEqual(0)
        expect(placed.y).toBeGreaterThanOrEqual(0)
        expect(placed.x + placed.drawWidth).toBeLessThanOrEqual(placed.width)
        expect(placed.y + placed.drawHeight).toBeLessThanOrEqual(placed.height)
      }
    }
  })

  it('draws a raster picture no larger than it is, and a vector one as large as the limits allow', () => {
    expect(workingSize(300, 100, false)).toEqual({ width: 300, height: 100 })
    expect(workingSize(3000, 1000, false)).toEqual({ width: 1200, height: 400 })
    expect(workingSize(120, 40, true)).toEqual({ width: 1200, height: 400 })
    expect(workingSize(24, 24, true)).toEqual({ width: 600, height: 600 })
  })
})

describe('the square icon', () => {
  it('holds a logo in the middle of a white tile, with room around it', () => {
    const placed = fitIcon(462, 149, ICON_LOGO_SHARE)
    expect(placed.width).toBe(512)
    expect(placed.height).toBe(512)
    expect(placed.drawWidth).toBe(389)
    expect(placed.drawHeight).toBe(125)
    expect(placed.x).toBe(61)
    expect(placed.y).toBe(193)
  })

  it('fills the tile with a square picture chosen as the icon', () => {
    expect(fitIcon(512, 512)).toEqual({ width: 512, height: 512, x: 0, y: 0, drawWidth: 512, drawHeight: 512 })
    expect(fitIcon(2000, 2000)).toMatchObject({ width: 512, drawWidth: 512 })
    // A small one makes the smallest allowed tile.
    expect(fitIcon(64, 64)).toMatchObject({ width: 192, height: 192, drawWidth: 192, drawHeight: 192 })
    expect(fitIcon(300, 300)).toMatchObject({ width: 300, drawWidth: 300 })
  })

  it('is square between 192 and 512 px whatever the picture', () => {
    for (const [width, height] of [[1, 1], [10, 400], [400, 10], [191, 193], [513, 20], [9000, 3000]] as const) {
      for (const share of [1, ICON_LOGO_SHARE]) {
        const placed = fitIcon(width, height, share)
        expect(placed.width).toBe(placed.height)
        expect(placed.width).toBeGreaterThanOrEqual(192)
        expect(placed.width).toBeLessThanOrEqual(512)
        expect(placed.x + placed.drawWidth).toBeLessThanOrEqual(placed.width)
        expect(placed.y + placed.drawHeight).toBeLessThanOrEqual(placed.height)
      }
    }
  })
})

/* ---- pure: pixels ------------------------------------------------------------------------------ */

/** A canvas's own pixels: a raster that may be changed in place. */
interface Pixels {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** A raster of one colour with rectangles painted on it. */
function raster(width: number, height: number, background: Rgba, ...rects: { x: number; y: number; w: number; h: number; colour: Rgba }[]): Pixels {
  const data = new Uint8ClampedArray(width * height * 4)
  const paint = (x0: number, y0: number, w: number, h: number, colour: Rgba) => {
    for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) data.set(colour, (y * width + x) * 4)
  }
  paint(0, 0, width, height, background)
  for (const rect of rects) paint(rect.x, rect.y, rect.w, rect.h, rect.colour)
  return { width, height, data }
}

/** The pixel of a raster at a point. */
function pixelAt({ width, data }: Raster, x: number, y: number): number[] {
  return Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 4))
}

const CLEAR: Rgba = [0, 0, 0, 0]
const WHITE: Rgba = [255, 255, 255, 255]
const BLACK: Rgba = [0, 0, 0, 255]
const BLUE: Rgba = [30, 58, 138, 255]
const ORANGE: Rgba = [249, 115, 22, 255]
const NAVY: Rgba = [11, 31, 75, 255]
const GOLD: Rgba = [201, 162, 39, 255]
const RED: Rgba = [216, 30, 44, 255]

describe('what is drawn in a picture', () => {
  it('is the box around its pixels that are not transparent', () => {
    expect(contentBounds(raster(40, 30, CLEAR, { x: 10, y: 5, w: 20, h: 12, colour: BLUE }))).toEqual({ x: 10, y: 5, width: 20, height: 12 })
    // An opaque picture is its whole canvas.
    expect(contentBounds(raster(8, 6, WHITE))).toEqual({ x: 0, y: 0, width: 8, height: 6 })
  })

  it('counts a soft edge and leaves out a nearly invisible pixel', () => {
    const picture = raster(20, 20, CLEAR, { x: 8, y: 8, w: 4, h: 4, colour: BLUE }, { x: 7, y: 8, w: 1, h: 4, colour: [30, 58, 138, 40] }, { x: 0, y: 0, w: 1, h: 1, colour: [30, 58, 138, 3] })
    expect(contentBounds(picture)).toEqual({ x: 7, y: 8, width: 5, height: 4 })
  })

  it('is nothing in a picture that is transparent everywhere', () => {
    expect(contentBounds(raster(12, 12, CLEAR))).toBeNull()
  })
})

describe('the colours of a logo', () => {
  it('are its own colours, the most used first', () => {
    const picture = raster(100, 100, CLEAR, { x: 0, y: 0, w: 100, h: 60, colour: BLUE }, { x: 0, y: 60, w: 100, h: 40, colour: ORANGE })
    expect(extractColours(picture)).toEqual(['#1e3a8a', '#f97316'])
  })

  it('leave out transparent, near-white and near-black pixels', () => {
    const picture = raster(
      100,
      100,
      CLEAR,
      { x: 0, y: 0, w: 100, h: 40, colour: WHITE },
      { x: 0, y: 40, w: 100, h: 30, colour: BLACK },
      { x: 0, y: 70, w: 100, h: 5, colour: [250, 248, 244, 255] },
      { x: 0, y: 75, w: 100, h: 5, colour: [18, 20, 24, 255] },
      { x: 0, y: 80, w: 100, h: 20, colour: BLUE },
    )
    expect(extractColours(picture)).toEqual(['#1e3a8a'])
    expect(extractColours(raster(50, 50, WHITE, { x: 5, y: 5, w: 40, h: 40, colour: BLACK }))).toEqual([])
    expect(extractColours(raster(10, 10, CLEAR))).toEqual([])
  })

  it('count the shades of one colour (a soft edge, a JPEG’s noise) as that colour, named by its most used shade', () => {
    const picture = raster(
      100,
      100,
      CLEAR,
      { x: 0, y: 0, w: 100, h: 80, colour: BLUE },
      { x: 0, y: 80, w: 100, h: 6, colour: [34, 62, 146, 255] },
      { x: 0, y: 86, w: 100, h: 6, colour: [26, 52, 130, 255] },
      { x: 0, y: 92, w: 100, h: 8, colour: [40, 70, 150, 255] },
    )
    expect(extractColours(picture)).toEqual(['#1e3a8a'])
  })

  it('leave out a colour that covers a sliver of the logo', () => {
    const picture = raster(100, 100, BLUE, { x: 0, y: 0, w: 100, h: 1, colour: ORANGE })
    expect(extractColours(picture)).toEqual(['#1e3a8a'])
  })

  it('put a vivid colour before a grey of the same size', () => {
    const picture = raster(100, 100, CLEAR, { x: 0, y: 0, w: 100, h: 50, colour: [128, 128, 128, 255] }, { x: 0, y: 50, w: 100, h: 50, colour: ORANGE })
    expect(extractColours(picture)).toEqual(['#f97316', '#808080'])
  })

  it('are at most five, each written as #rrggbb', () => {
    const colours: Rgba[] = [
      [200, 30, 30, 255],
      [30, 160, 60, 255],
      [30, 58, 138, 255],
      [249, 115, 22, 255],
      [124, 58, 237, 255],
      [247, 185, 22, 255],
      [20, 150, 150, 255],
    ]
    const picture = raster(70, 70, CLEAR, ...colours.map((colour, index) => ({ x: index * 10, y: 0, w: 10, h: 70, colour })))
    const found = extractColours(picture)
    expect(found).toHaveLength(5)
    for (const colour of found) expect(colour).toMatch(/^#[0-9a-f]{6}$/)
    expect(new Set(found).size).toBe(5)
    expect(extractColours(picture, 3)).toHaveLength(3)
  })

  it('read a large picture by sampling it', () => {
    const picture = raster(600, 600, BLUE, { x: 0, y: 0, w: 600, h: 200, colour: ORANGE })
    expect(extractColours(picture)).toEqual(['#1e3a8a', '#f97316'])
  })

  it('leave out what compression draws around a shape: a pale halo, a dark rim (UX review: #ffffd2 was offered for a navy and gold logo)', () => {
    // A navy and gold logo saved as a JPEG: 3 % of its pixels are a pale yellow between the gold and the white around it.
    const picture = raster(
      100,
      100,
      CLEAR,
      { x: 0, y: 0, w: 100, h: 67, colour: NAVY },
      { x: 0, y: 67, w: 100, h: 27, colour: GOLD },
      { x: 0, y: 94, w: 100, h: 3, colour: [255, 255, 210, 255] },
      { x: 0, y: 97, w: 100, h: 3, colour: [40, 36, 31, 255] },
    )
    expect(extractColours(picture)).toEqual(['#0b1f4b', '#c9a227'])
  })

  it('keep a very light or a very dark colour that much of the logo has: it is the logo’s own', () => {
    // A pale yellow mark with a small dark line: the pale colour is most of the logo.
    expect(extractColours(raster(100, 100, CLEAR, { x: 0, y: 0, w: 100, h: 70, colour: [255, 243, 176, 255] }, { x: 0, y: 70, w: 100, h: 30, colour: BLUE }))).toEqual(['#fff3b0', '#1e3a8a'])
    // A near-black navy wordmark with a gold line: the navy is most of it (as in the test above).
    expect(extractColours(raster(100, 100, CLEAR, { x: 0, y: 0, w: 100, h: 80, colour: NAVY }, { x: 0, y: 80, w: 100, h: 20, colour: GOLD }))).toContain('#0b1f4b')
  })

  it('offer two shades a person would call one colour once, under the more used one', () => {
    // Two golds apart by more than a JPEG's noise, of one hue: a gradient, or the same gold on two layers.
    const picture = raster(100, 100, CLEAR, { x: 0, y: 0, w: 100, h: 50, colour: NAVY }, { x: 0, y: 50, w: 100, h: 30, colour: GOLD }, { x: 0, y: 80, w: 100, h: 20, colour: [226, 187, 80, 255] })
    const found = extractColours(picture)
    expect(found).toEqual(['#0b1f4b', '#c9a227'])
    // Two colours of different hues stay two, however close in lightness.
    expect(extractColours(raster(100, 100, CLEAR, { x: 0, y: 0, w: 100, h: 50, colour: [201, 162, 39, 255] }, { x: 0, y: 50, w: 100, h: 50, colour: [201, 80, 39, 255] }))).toHaveLength(2)
  })
})

/* ---- pure: a flat background ------------------------------------------------------------------- */

describe('the flat background of a picture without transparency', () => {
  it('is made transparent when it is white: the drawing stays, and is all that is left to fit', () => {
    const picture = raster(60, 40, WHITE, { x: 10, y: 8, w: 30, h: 20, colour: BLUE })
    expect(clearFlatBackground(picture, 'light')).toBe(true)
    expect(pixelAt(picture, 0, 0)[3]).toBe(0)
    expect(pixelAt(picture, 59, 39)[3]).toBe(0)
    expect(pixelAt(picture, 25, 18)).toEqual([...BLUE])
    // The drawing's own edge keeps its colour, opaque.
    expect(pixelAt(picture, 10, 8)).toEqual([...BLUE])
    expect(contentBounds(picture)).toEqual({ x: 10, y: 8, width: 30, height: 20 })
  })

  it('goes from the edges inwards only: what the drawing encloses stays as it is', () => {
    // A red square with a white cross in it (the inside of a letter is the same).
    const picture = raster(60, 60, WHITE, { x: 10, y: 10, w: 40, h: 40, colour: RED }, { x: 26, y: 16, w: 8, h: 28, colour: WHITE }, { x: 16, y: 26, w: 28, h: 8, colour: WHITE })
    expect(clearFlatBackground(picture, 'light')).toBe(true)
    expect(pixelAt(picture, 2, 2)[3]).toBe(0)
    expect(pixelAt(picture, 30, 30)).toEqual([...WHITE])
    expect(pixelAt(picture, 12, 12)).toEqual([...RED])
  })

  it('takes a JPEG’s noise with it: a background that is white within a few levels', () => {
    const picture = raster(80, 50, WHITE, { x: 20, y: 10, w: 40, h: 30, colour: NAVY })
    // Off-white specks all over the background, some right beside the drawing.
    const noisy: [number, number, Rgba][] = [
      [0, 0, [251, 252, 250, 255]],
      [5, 3, [247, 249, 252, 255]],
      [19, 20, [243, 244, 246, 255]],
      [60, 25, [240, 242, 239, 255]],
      [79, 49, [250, 250, 253, 255]],
    ]
    for (const [x, y, colour] of noisy) picture.data.set(colour, (y * 80 + x) * 4)
    expect(clearFlatBackground(picture, 'light')).toBe(true)
    for (const [x, y] of noisy) expect(pixelAt(picture, x, y)[3]).toBeLessThan(255)
    expect(pixelAt(picture, 40, 25)).toEqual([...NAVY])
  })

  it('gives the drawing’s rim its soft edge back: a pixel that is half drawing, half background becomes half transparent', () => {
    // One column between the navy and the white that is a mix of the two, as antialiasing leaves it.
    const half: Rgba = [133, 143, 165, 255]
    const picture = raster(60, 40, WHITE, { x: 20, y: 10, w: 20, h: 20, colour: NAVY }, { x: 19, y: 10, w: 1, h: 20, colour: half })
    expect(clearFlatBackground(picture, 'light')).toBe(true)
    const rim = pixelAt(picture, 19, 20)
    // The drawing's own colour, about half as opaque: no white fringe on a surface that is not white.
    expect(rim.slice(0, 3)).toEqual([11, 31, 75])
    expect(rim[3]).toBeGreaterThan(110)
    expect(rim[3]).toBeLessThan(145)
    // A pixel of the drawing itself at its edge stays opaque.
    expect(pixelAt(picture, 39, 20)).toEqual([...NAVY])
  })

  it.each([
    ['a picture with transparency of its own', () => raster(40, 40, CLEAR, { x: 5, y: 5, w: 30, h: 30, colour: BLUE })],
    ['a white picture with one transparent corner', () => raster(40, 40, WHITE, { x: 0, y: 0, w: 1, h: 1, colour: CLEAR }, { x: 10, y: 10, w: 20, h: 20, colour: BLUE })],
    ['a background of another colour, which may be the logo’s own tile', () => raster(40, 40, RED, { x: 14, y: 8, w: 12, h: 24, colour: WHITE })],
    ['a light grey background (not white: it may be meant)', () => raster(40, 40, [214, 214, 214, 255], { x: 10, y: 10, w: 20, h: 20, colour: BLUE })],
    ['a drawing that reaches the picture’s edges', () => raster(40, 40, WHITE, { x: 0, y: 12, w: 40, h: 16, colour: BLUE })],
    ['a black background, in a picture for white backgrounds', () => raster(40, 40, BLACK, { x: 10, y: 10, w: 20, h: 20, colour: WHITE })],
  ] as const)('is left alone in %s', (_what, make) => {
    const picture = make()
    const before = [...picture.data]
    expect(clearFlatBackground(picture, 'light')).toBe(false)
    expect([...picture.data]).toEqual(before)
  })

  it('is black, not white, for a logo meant for dark surfaces', () => {
    const onBlack = raster(60, 40, BLACK, { x: 10, y: 8, w: 30, h: 20, colour: WHITE })
    expect(clearFlatBackground(onBlack, 'dark')).toBe(true)
    expect(pixelAt(onBlack, 0, 0)[3]).toBe(0)
    expect(pixelAt(onBlack, 25, 18)).toEqual([...WHITE])
    const onWhite = raster(60, 40, WHITE, { x: 10, y: 8, w: 30, h: 20, colour: BLUE })
    expect(clearFlatBackground(onWhite, 'dark')).toBe(false)
  })

  it('leaves nothing of a picture that is its background only', () => {
    const picture = raster(30, 30, WHITE)
    expect(clearFlatBackground(picture, 'light')).toBe(true)
    expect(contentBounds(picture)).toBeNull()
  })
})

/* ---- pure: what a picture is like -------------------------------------------------------------- */

describe('a picture for the background it is chosen for', () => {
  it('measures how much of what is drawn is near-white and near-black', () => {
    expect(toneShares(raster(10, 10, CLEAR))).toBeNull()
    expect(toneShares(raster(10, 10, CLEAR, { x: 0, y: 0, w: 10, h: 5, colour: WHITE }))).toEqual({ light: 1, dark: 0, cover: 0.5 })
    expect(toneShares(raster(10, 10, CLEAR, { x: 0, y: 0, w: 10, h: 5, colour: BLACK }))).toEqual({ light: 0, dark: 1, cover: 0.5 })
    const mixed = toneShares(raster(10, 10, WHITE, { x: 0, y: 0, w: 10, h: 2, colour: BLUE }, { x: 0, y: 2, w: 10, h: 3, colour: BLACK }))!
    expect(mixed.light).toBeCloseTo(0.5)
    expect(mixed.dark).toBeCloseTo(0.3)
    expect(mixed.cover).toBe(1)
    // A faint pixel counts for as much as it shows.
    const soft = toneShares(raster(2, 1, CLEAR, { x: 0, y: 0, w: 1, h: 1, colour: WHITE }, { x: 1, y: 0, w: 1, h: 1, colour: [30, 58, 138, 51] }))!
    expect(soft.light).toBeCloseTo(1 / 1.2)
  })

  it('refuses a logo for white backgrounds that is white itself (UX review: accepted without a word, and invisible everywhere)', () => {
    const whiteLogo = raster(100, 40, CLEAR, { x: 5, y: 5, w: 90, h: 30, colour: WHITE })
    expect(toneProblem(whiteLogo, 'light')).toBe('too-light')
    // The same picture is what the dark-surface place is for.
    expect(toneProblem(whiteLogo, 'dark')).toBeNull()
    // Not white, but as invisible on white: a pale yellow, a cream.
    expect(toneProblem(raster(100, 40, CLEAR, { x: 5, y: 5, w: 90, h: 30, colour: [255, 245, 157, 255] }), 'light')).toBe('too-light')
    expect(toneProblem(raster(100, 40, CLEAR, { x: 5, y: 5, w: 90, h: 30, colour: [250, 250, 250, 255] }), 'light')).toBe('too-light')
  })

  it('refuses a logo for dark surfaces that is black, or a navy as dark', () => {
    expect(toneProblem(raster(100, 40, CLEAR, { x: 5, y: 5, w: 90, h: 30, colour: BLACK }), 'dark')).toBe('too-dark')
    expect(toneProblem(raster(100, 40, CLEAR, { x: 5, y: 5, w: 90, h: 30, colour: NAVY }), 'dark')).toBe('too-dark')
    expect(toneProblem(raster(100, 40, CLEAR, { x: 5, y: 5, w: 90, h: 30, colour: NAVY }), 'light')).toBeNull()
  })

  it('takes a logo of which enough shows: a colour beside the white, a pastel, a mid grey', () => {
    // A red mark with a white cross in it, and a name in white a third of the mark's size: the mark shows on white.
    expect(toneProblem(raster(100, 60, CLEAR, { x: 0, y: 0, w: 45, h: 40, colour: RED }, { x: 50, y: 0, w: 40, h: 40, colour: WHITE }), 'light')).toBeNull()
    // A white wordmark with a small gold line under it (the white version of a logo, made for dark surfaces): next to nothing shows.
    expect(toneProblem(raster(100, 60, CLEAR, { x: 0, y: 0, w: 88, h: 40, colour: WHITE }, { x: 88, y: 0, w: 12, h: 40, colour: GOLD }), 'light')).toBe('too-light')
    expect(toneProblem(raster(100, 60, CLEAR, { x: 0, y: 0, w: 100, h: 40, colour: [249, 198, 208, 255] }), 'light')).toBeNull()
    for (const ground of ['light', 'dark'] as const) expect(toneProblem(raster(100, 60, CLEAR, { x: 0, y: 0, w: 100, h: 40, colour: [128, 128, 128, 255] }), ground)).toBeNull()
    expect(toneProblem(raster(10, 10, CLEAR), 'light')).toBeNull()
  })

  it('takes a picture without transparency whose background is light and whose drawing is small: it shows as it is', () => {
    // A dark wordmark on cream (a scan, a letterhead): nine tenths of it are the cream, and it reads perfectly.
    const cream: Rgba = [245, 239, 224, 255]
    expect(toneProblem(raster(200, 80, cream, { x: 20, y: 30, w: 160, h: 8, colour: NAVY }), 'light')).toBeNull()
    // The mirror: a white wordmark on a navy tile, for dark surfaces.
    expect(toneProblem(raster(200, 80, NAVY, { x: 20, y: 30, w: 160, h: 8, colour: WHITE }), 'dark')).toBeNull()
    // A rectangle that is light all over shows nothing on white.
    expect(toneProblem(raster(200, 80, cream, { x: 20, y: 30, w: 160, h: 8, colour: WHITE }), 'light')).toBe('too-light')
    expect(toneProblem(raster(200, 80, BLACK, { x: 20, y: 30, w: 160, h: 8, colour: NAVY }), 'dark')).toBe('too-dark')
  })

  it('refuses a strip, a column and a picture too small to show sharply (UX review: 27:1, 1:4 and 36 px were accepted as they were)', () => {
    expect([LOGO_MAX_WIDE, LOGO_MAX_TALL, MIN_SOURCE_SIDE]).toEqual([8, 2, 96])
    expect(shapeProblem(2400, 300, false)).toBeNull()
    expect(shapeProblem(2401, 300, false)).toBe('too-wide')
    expect(shapeProblem(2300, 85, false)).toBe('too-wide')
    expect(shapeProblem(300, 600, false)).toBeNull()
    expect(shapeProblem(299, 600, false)).toBe('too-tall')
    expect(shapeProblem(200, 880, false)).toBe('too-tall')
    expect(shapeProblem(96, 96, false)).toBeNull()
    expect(shapeProblem(96, 40, false)).toBeNull()
    expect(shapeProblem(95, 95, false)).toBe('too-small')
    expect(shapeProblem(36, 36, false)).toBe('too-small')
    // A vector picture is drawn at any size: only its shape counts.
    expect(shapeProblem(24, 24, true)).toBeNull()
    expect(shapeProblem(300, 20, true)).toBe('too-wide')
  })
})

/* ---- the canvas pipeline, on fakes ------------------------------------------------------------- */

/** A picture: one colour, with a transparent margin all around (a share of each side), or a failure to decode. */
interface Picture {
  width: number
  height: number
  colour: Rgba
  margin?: number
}

/** What each object URL stands for, and what each blob holds. */
const pictures = new Map<string, Picture | Sampler | 'broken'>()
const contents = new WeakMap<Blob, Picture | Sampler | 'broken'>()

/** A canvas that was encoded: its pixels, readable again as a picture. */
interface Sampler {
  width: number
  height: number
  sample: (u: number, v: number) => Rgba
}

function sampleOf(source: Picture | Sampler): (u: number, v: number) => Rgba {
  if ('sample' in source) return source.sample
  const margin = source.margin ?? 0
  return (u, v) => (u < margin || v < margin || u >= 1 - margin || v >= 1 - margin ? CLEAR : source.colour)
}

class FakeImage {
  decoding = 'auto'
  naturalWidth = 0
  naturalHeight = 0
  picture: Picture | Sampler | null = null
  private listeners: Record<string, (() => void)[]> = {}

  addEventListener(type: string, listener: () => void) {
    ;(this.listeners[type] ??= []).push(listener)
  }

  set src(url: string) {
    const picture = pictures.get(url)
    queueMicrotask(() => {
      if (!picture || picture === 'broken') {
        for (const listener of this.listeners.error ?? []) listener()
        return
      }
      this.picture = picture
      this.naturalWidth = picture.width
      this.naturalHeight = picture.height
      for (const listener of this.listeners.load ?? []) listener()
    })
  }
}

/** `#rrggbb` as an opaque pixel. */
function pixelOf(hex: string): Rgba {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16), 255]
}

/** A canvas's pixels and the calls made on its context. */
class FakeContext {
  fillStyle = '#000000'
  font = '10px sans-serif'
  textAlign = 'start'
  textBaseline = 'alphabetic'
  imageSmoothingEnabled = false
  imageSmoothingQuality = 'low'
  data: Uint8ClampedArray
  readonly draws: { source: unknown; args: number[] }[] = []
  /** What was written on the canvas: the text, where, in which face and colour. */
  readonly texts: { text: string; x: number; y: number; font: string; fillStyle: string; textAlign: string; textBaseline: string }[] = []
  readonly canvas: HTMLCanvasElement

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.data = new Uint8ClampedArray(canvas.width * canvas.height * 4)
  }

  fillRect(x: number, y: number, width: number, height: number) {
    const colour = pixelOf(this.fillStyle)
    for (let row = y; row < y + height; row += 1) for (let column = x; column < x + width; column += 1) this.data.set(colour, (row * this.canvas.width + column) * 4)
  }

  /** The pixels are the canvas's own (`getImageData` hands them out), so a change to them is already on it. */
  putImageData(image: { data: Uint8ClampedArray }) {
    this.data = image.data
  }

  /** A letter's ink in this fake face: 0.6 of the size wide, 0.7 tall above the baseline, starting 0.05 after the point it is drawn at. */
  measureText(text: string) {
    const size = Number.parseFloat(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? '10')
    return { width: size * 0.7 * text.length, actualBoundingBoxLeft: -size * 0.05, actualBoundingBoxRight: size * 0.65, actualBoundingBoxAscent: size * 0.7, actualBoundingBoxDescent: 0 }
  }

  fillText(text: string, x: number, y: number) {
    this.texts.push({ text, x, y, font: this.font, fillStyle: this.fillStyle, textAlign: this.textAlign, textBaseline: this.textBaseline })
  }

  /** `drawImage(source, dx, dy, dw, dh)` or `drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh)`, nearest neighbour, source over. */
  drawImage(source: FakeImage | HTMLCanvasElement, ...args: number[]) {
    this.draws.push({ source, args })
    const sampler = source instanceof FakeImage ? sampleOf(source.picture!) : contextOf(source).sampler()
    const [sourceWidth, sourceHeight] = source instanceof FakeImage ? [source.naturalWidth, source.naturalHeight] : [source.width, source.height]
    const [sx, sy, sw, sh, dx, dy, dw, dh] = args.length === 8 ? args : [0, 0, sourceWidth, sourceHeight, ...args]
    for (let row = 0; row < dh!; row += 1) {
      for (let column = 0; column < dw!; column += 1) {
        const pixel = sampler((sx! + ((column + 0.5) / dw!) * sw!) / sourceWidth, (sy! + ((row + 0.5) / dh!) * sh!) / sourceHeight)
        if (pixel[3] === 0) continue
        this.data.set(pixel, ((dy! + row) * this.canvas.width + dx! + column) * 4)
      }
    }
  }

  getImageData(_x: number, _y: number, width: number, height: number) {
    return { width, height, data: this.data }
  }

  sampler(): (u: number, v: number) => Rgba {
    const { width, height } = this.canvas
    const data = this.data
    return (u, v) => {
      const offset = (Math.min(height - 1, Math.floor(v * height)) * width + Math.min(width - 1, Math.floor(u * width))) * 4
      return [data[offset]!, data[offset + 1]!, data[offset + 2]!, data[offset + 3]!]
    }
  }
}

const contexts = new WeakMap<HTMLCanvasElement, FakeContext>()
/** Every canvas the pipeline made, in order. */
let canvases: HTMLCanvasElement[] = []
/** Bytes of "PNG" per pixel of a canvas: the test's weight of a picture. */
let bytesPerPixel = 0.05

function contextOf(canvas: HTMLCanvasElement): FakeContext {
  const context = contexts.get(canvas)
  if (!context) throw new Error('A canvas was read before anything was drawn on it')
  return context
}

/** A file whose bytes are not what is uploaded. */
function file(picture: Picture | Sampler | 'broken', { name = 'logo.png', type = 'image/png', text = 'the original bytes' } = {}): File {
  const chosen = new File([text], name, { type })
  contents.set(chosen, picture)
  return chosen
}

/** A picture of a rectangle of `colour` in the middle of a `background`: a share of each side is background. */
function framed(width: number, height: number, background: Rgba, colour: Rgba, margin = 0.2): Sampler {
  return { width, height, sample: (u, v) => (u < margin || v < margin || u >= 1 - margin || v >= 1 - margin ? background : colour) }
}

/** A picture whose every pixel weighs 600 bytes as PNG: it fits under the limit at no allowed size. */
function heavyFile(picture: Picture): File {
  bytesPerPixel = 600
  return file(picture)
}

beforeEach(() => {
  canvases = []
  bytesPerPixel = 0.05
  let urls = 0
  vi.stubGlobal('Image', FakeImage)
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = `blob:test/${(urls += 1)}`
    const content = contents.get(blob as Blob)
    if (content) pictures.set(url, content)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
    pictures.delete(url)
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let context = contexts.get(this)
    if (!context) {
      context = new FakeContext(this)
      contexts.set(this, context)
      canvases.push(this)
    }
    return context as unknown as CanvasRenderingContext2D
  } as unknown as typeof HTMLCanvasElement.prototype.getContext)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback: BlobCallback, type?: string) {
    const context = contextOf(this)
    const blob = new Blob([new Uint8Array(Math.round(this.width * this.height * bytesPerPixel))], { type })
    contents.set(blob, { width: this.width, height: this.height, sample: context.sampler() })
    callback(blob)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  pictures.clear()
})

describe('a chosen file as a logo', () => {
  it('is decoded by the browser, fitted on a canvas and encoded as PNG: the original bytes never leave', async () => {
    const chosen = file({ width: 2400, height: 800, colour: BLUE }, { name: 'logo.jpg', type: 'image/jpeg' })
    const logo = await prepareLogo(chosen)
    expect(logo.blob).not.toBe(chosen)
    expect(logo.blob.type).toBe('image/png')
    expect(await logo.blob.text()).not.toContain('the original bytes')
    expect([logo.width, logo.height]).toEqual([1200, 400])
    expect(logo.blob.size).toBeLessThanOrEqual(MAX_ASSET_BYTES)
    expect(logo.colours).toEqual(['#1e3a8a'])
    // The object URL the browser decoded from is released.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test/1')
  })

  it('cuts the empty room around the drawing away, so the logo fills its place', async () => {
    // A 1000 × 400 file whose drawing is its middle 500 × 200.
    const logo = await prepareLogo(file({ width: 1000, height: 400, colour: ORANGE, margin: 0.25 }))
    expect([logo.width, logo.height]).toEqual([500, 200])
    // The final canvas is drawn edge to edge.
    const bounds = contentBounds({ width: logo.width, height: logo.height, data: contextOf(canvases.at(-1)!).data })
    expect(bounds).toEqual({ x: 0, y: 0, width: 500, height: 200 })
  })

  it('rasterises an SVG through an image, as large as the limits allow', async () => {
    const logo = await prepareLogo(file({ width: 120, height: 40, colour: BLUE }, { name: 'logo.svg', type: 'image/svg+xml' }))
    expect([logo.width, logo.height]).toEqual([1200, 400])
    expect(logo.blob.type).toBe('image/png')
  })

  it('reads the size an SVG states when the browser gives the image none', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><rect width="300" height="100"/></svg>'
    const chosen = file({ width: 0, height: 0, colour: BLUE }, { name: 'logo.svg', type: 'image/svg+xml', text: svg })
    const logo = await prepareLogo(chosen)
    expect([logo.width, logo.height]).toEqual([1200, 400])
    expect(await logo.blob.text()).not.toContain('<svg')
  })

  it('enlarges a low picture to the smallest allowed height, and a small vector one as far as the limits allow', async () => {
    const low = await prepareLogo(file({ width: 96, height: 12, colour: BLUE }))
    expect([low.width, low.height]).toEqual([256, 32])
    const vector = await prepareLogo(file({ width: 16, height: 16, colour: BLUE }, { name: 'mark.svg', type: 'image/svg+xml' }))
    expect([vector.width, vector.height]).toEqual([600, 600])
  })

  it('says how wide the drawing is for its height, without the room around it', async () => {
    const wordmark = await prepareLogo(file({ width: 1000, height: 400, colour: ORANGE, margin: 0.25 }))
    expect(wordmark.aspect).toBeCloseTo(2.5)
    expect(wordmark.aspect).toBeGreaterThan(WORDMARK_MIN_RATIO)
    const emblem = await prepareLogo(file({ width: 300, height: 300, colour: ORANGE }))
    expect(emblem.aspect).toBe(1)
  })

  it('takes the white background of a JPEG away: the PNG is the drawing alone, on nothing (UX review: a white rectangle on the grey page)', async () => {
    const jpeg = file(framed(500, 250, WHITE, NAVY), { name: 'atlas.jpg', type: 'image/jpeg' })
    const logo = await prepareLogo(jpeg)
    // The drawing is the middle 300 × 150: the white around it is gone, and with it the room it took.
    expect([logo.width, logo.height]).toEqual([300, 150])
    expect(logo.aspect).toBe(2)
    expect(logo.colours).toEqual(['#0b1f4b'])
    const pixels = contextOf(canvases.at(-1)!).sampler()
    expect(pixels(0.01, 0.01)).toEqual([...NAVY])
    // On the working canvas the background is transparent now.
    const work = contextOf(canvases[0]!)
    expect(work.sampler()(0.05, 0.05)[3]).toBe(0)
    expect(work.sampler()(0.5, 0.5)).toEqual([...NAVY])
  })

  it('keeps a background that is the logo’s own tile: a colour, with white letters on it', async () => {
    const tile = await prepareLogo(file(framed(400, 400, RED, WHITE, 0.3)))
    expect([tile.width, tile.height]).toEqual([400, 400])
    expect(contextOf(canvases.at(-1)!).sampler()(0.05, 0.05)).toEqual([...RED])
  })

  it.each([
    ['a white logo on nothing, for white backgrounds', () => prepareLogo(file({ width: 400, height: 120, colour: WHITE, margin: 0.1 })), 'too-light'],
    ['a picture that is white all over: once its background is gone, nothing is left', () => prepareLogo(file(framed(400, 200, WHITE, [250, 250, 250, 255]))), 'empty'],
    ['a black logo, for dark surfaces', () => prepareLogo(file({ width: 400, height: 120, colour: BLACK, margin: 0.1 }), 'dark'), 'too-dark'],
    ['a strip more than eight times as wide as tall', () => prepareLogo(file({ width: 2400, height: 160, colour: BLUE, margin: 0.02 })), 'too-wide'],
    ['a column more than twice as tall as wide', () => prepareLogo(file({ width: 220, height: 900, colour: BLUE })), 'too-tall'],
    ['a picture of 40 px', () => prepareLogo(file({ width: 40, height: 40, colour: BLUE })), 'too-small'],
    ['a large picture whose drawing is small', () => prepareLogo(file({ width: 400, height: 400, colour: BLUE, margin: 0.4 })), 'too-small'],
  ] as const)('refuses %s', async (_what, prepare, problem) => {
    expect(imageProblemOf(await prepare().catch((error: unknown) => error))).toBe(problem)
  })

  it('takes for dark surfaces what it refuses for white ones, and the reverse', async () => {
    const white = () => file({ width: 400, height: 120, colour: WHITE, margin: 0.1 })
    expect((await prepareLogo(white(), 'dark')).width).toBe(320)
    const navy = () => file({ width: 400, height: 120, colour: NAVY, margin: 0.1 })
    expect((await prepareLogo(navy(), 'light')).width).toBe(320)
    expect(imageProblemOf(await prepareLogo(navy(), 'dark').catch((error: unknown) => error))).toBe('too-dark')
    // A white logo on a black background, for dark surfaces: the black goes, the logo stays.
    const onBlack = await prepareLogo(file(framed(500, 250, BLACK, WHITE)), 'dark')
    expect([onBlack.width, onBlack.height]).toEqual([300, 150])
  })

  it('draws a heavy picture smaller until it fits under 512 KiB', async () => {
    // 1200 × 600 at 1 byte a pixel is 720,000 bytes: one step of a fifth brings it under the limit.
    bytesPerPixel = 1
    const logo = await prepareLogo(file({ width: 1200, height: 600, colour: BLUE }))
    expect([logo.width, logo.height]).toEqual([960, 480])
    expect(logo.blob.size).toBeLessThanOrEqual(MAX_ASSET_BYTES)
  })

  it.each([
    ['a file the browser cannot decode', () => file('broken', { name: 'notes.txt', type: 'text/plain' }), 'undecodable'],
    ['a picture with nothing drawn in it', () => file({ width: 200, height: 100, colour: CLEAR }), 'empty'],
    ['an SVG without any size', () => file({ width: 0, height: 0, colour: BLUE }, { name: 'logo.svg', type: 'image/svg+xml', text: '<svg xmlns="http://www.w3.org/2000/svg"/>' }), 'undecodable'],
    ['a picture too detailed to fit under the limit at any size', () => heavyFile({ width: 300, height: 100, colour: BLUE }), 'too-heavy'],
  ] as const)('refuses %s, saying why', async (_what, make, problem) => {
    const refusal = await prepareLogo(make()).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(ImagePipelineError)
    expect(imageProblemOf(refusal)).toBe(problem)
  })

  it('refuses a file too large to open without decoding it', async () => {
    const huge = file({ width: 100, height: 100, colour: BLUE })
    Object.defineProperty(huge, 'size', { value: MAX_SOURCE_BYTES + 1 })
    expect(imageProblemOf(await prepareLogo(huge).catch((error: unknown) => error))).toBe('source-too-large')
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(imageProblemOf(new Error('another failure'))).toBeNull()
  })
})

describe('the square icon', () => {
  it('is made from the prepared logo: the logo on a white tile, with room around it', async () => {
    const logo = await prepareLogo(file({ width: 462, height: 149, colour: BLUE }))
    const icon = await iconFromLogo(logo.blob)
    expect([icon.width, icon.height]).toEqual([512, 512])
    expect(icon.blob.type).toBe('image/png')
    expect(icon.colours).toEqual([])
    const pixels = contextOf(canvases.at(-1)!).sampler()
    // A white corner, the logo's colour in the middle.
    expect(pixels(0.02, 0.02)).toEqual([255, 255, 255, 255])
    expect(pixels(0.5, 0.5)).toEqual([30, 58, 138, 255])
    expect(pixels(0.5, 0.95)).toEqual([255, 255, 255, 255])
  })

  it('is a picture chosen by hand, on white, as large as the tile', async () => {
    const icon = await prepareIcon(file({ width: 800, height: 800, colour: ORANGE }))
    expect([icon.width, icon.height]).toEqual([512, 512])
    expect(contextOf(canvases.at(-1)!).sampler()(0.01, 0.01)).toEqual([249, 115, 22, 255])
    // A picture that is not square keeps its proportions, the rest of the tile white.
    const wide = await prepareIcon(file({ width: 400, height: 100, colour: ORANGE }))
    expect([wide.width, wide.height]).toEqual([400, 400])
    const pixels = contextOf(canvases.at(-1)!).sampler()
    expect(pixels(0.5, 0.5)).toEqual([249, 115, 22, 255])
    expect(pixels(0.5, 0.05)).toEqual([255, 255, 255, 255])
  })

  it('refuses a file the browser cannot decode', async () => {
    expect(imageProblemOf(await prepareIcon(file('broken')).catch((error: unknown) => error))).toBe('undecodable')
  })

  it('refuses a picture that would be a blank tile, an empty one, and one too small to show sharply', async () => {
    // A white mark on nothing: on the white tile nothing of it would show.
    expect(imageProblemOf(await prepareIcon(file({ width: 400, height: 400, colour: WHITE, margin: 0.1 })).catch((error: unknown) => error))).toBe('too-light')
    expect(imageProblemOf(await prepareIcon(file({ width: 400, height: 400, colour: CLEAR })).catch((error: unknown) => error))).toBe('empty')
    expect(imageProblemOf(await prepareIcon(file({ width: 36, height: 36, colour: BLUE })).catch((error: unknown) => error))).toBe('too-small')
    // A small vector picture is drawn as large as the tile.
    expect((await prepareIcon(file({ width: 24, height: 24, colour: BLUE }, { name: 'mark.svg', type: 'image/svg+xml' }))).width).toBe(192)
  })

  it('is the first letter of the company’s name on its colour, for a logo too wide to read on a small square', async () => {
    const icon = await letterIcon({ letter: 'S', background: '#f5b800', ink: '#1c262b' })
    expect([icon.width, icon.height]).toEqual([512, 512])
    expect(icon.blob.type).toBe('image/png')
    expect(icon.aspect).toBe(1)
    const tile = contextOf(canvases.at(-1)!)
    // The whole tile is the company's colour.
    for (const [u, v] of [[0.01, 0.01], [0.5, 0.5], [0.99, 0.99]] as const) expect(tile.sampler()(u, v)).toEqual([245, 184, 0, 255])
    // One letter, in the surface's ink and the app's own bold face.
    expect(tile.texts).toHaveLength(1)
    const [drawn] = tile.texts
    expect(drawn).toMatchObject({ text: 'S', fillStyle: '#1c262b' })
    expect(drawn!.font).toMatch(/^700 \d+px "Readex Pro"/)
    // As large as half the tile, its ink in the middle: here 0.6 wide and 0.7 tall of its size, 0.05 after its point.
    const size = Number.parseFloat(/(\d+)px/.exec(drawn!.font)![1]!)
    expect(size * 0.7).toBeCloseTo(256, -1)
    expect(drawn!.x + size * 0.05 + (size * 0.6) / 2).toBeCloseTo(256, 0)
    expect(drawn!.y - (size * 0.7) / 2).toBeCloseTo(256, 0)
  })

  it('draws an Arabic letter the same way, and the neutral tile for a company without a colour', async () => {
    await letterIcon({ letter: 'ش', ...NEUTRAL_TILE })
    const tile = contextOf(canvases.at(-1)!)
    expect(tile.sampler()(0.5, 0.02)).toEqual([51, 68, 78, 255])
    expect(tile.texts[0]).toMatchObject({ text: 'ش', fillStyle: '#ffffff' })
  })
})

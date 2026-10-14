import { distance, luminance, toHex, toHsl, toRgb, type Rgb } from './colour'

/*
 * A company's logo, prepared in the platform owner's browser (Phase 12).
 *
 * The server keeps PNG files only and decodes none: whatever file is chosen (PNG, JPEG, WebP, GIF,
 * an SVG…) is decoded here by the browser through an `<img>`, drawn on a canvas inside the
 * contract's limits and encoded as PNG. The original bytes never leave this device: what is
 * uploaded is the canvas's own PNG, so no metadata, no script of an SVG and no oddity of the source
 * file goes with it. The server validates the PNG strictly all the same.
 *
 * A picture is also checked for the place it is chosen for, since nothing else would say so before
 * the company's people see it: a logo for white backgrounds that is itself white, a strip too long
 * or a mark too small to read where the app shows it. And a picture without transparency on a flat
 * white background (every JPEG) loses that background, so it does not stand as a white box on a
 * page that is not white.
 *
 * The geometry (`fitLogo`, `fitIcon`, `contentBounds`), the pixel work (`clearFlatBackground`,
 * `toneShares`, `shapeProblem`) and the colours (`extractColours`) are pure functions; `prepareLogo`,
 * `prepareIcon`, `iconFromLogo` and `letterIcon` are the thin DOM part around them.
 */

/** The contract's limits: a logo 32–1200 px wide and 32–600 px tall, an icon square 192–512 px, each at most 512 KiB. */
export const LOGO_LIMITS = { minWidth: 32, maxWidth: 1200, minHeight: 32, maxHeight: 600 } as const
export const ICON_LIMITS = { min: 192, max: 512 } as const
export const MAX_ASSET_BYTES = 512 * 1024
/** A chosen file larger than this is refused before the browser decodes it. */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024
/** The logo's share of the square icon made from it: room around it on the white tile. */
export const ICON_LOGO_SHARE = 0.76

/**
 * The shapes a logo may have where the app shows it (a 40 px row of the shell, a 56 px row of the
 * sign-in page): at most this many times as wide as tall, or as tall as wide. Beyond that it is a
 * hairline there: a 27:1 strip was 136 × 5 px in the sidebar.
 */
export const LOGO_MAX_WIDE = 8
export const LOGO_MAX_TALL = 2
/** A picture whose longer side has fewer pixels than this is too small to show sharply (a 36 px mark on a 64 px row). */
export const MIN_SOURCE_SIDE = 96
/** A logo wider than this many times its height is a wordmark: unreadable on a 16 px square. */
export const WORDMARK_MIN_RATIO = 2

export type ImageProblem =
  /** The browser cannot decode the file as an image. */
  | 'undecodable'
  /** Nothing is drawn in it (every pixel transparent). */
  | 'empty'
  /** The file is too large to open. */
  | 'source-too-large'
  /** The picture does not fit under the size limit even at its smallest allowed size. */
  | 'too-heavy'
  /** Too few pixels to show sharply. */
  | 'too-small'
  /** A strip: more than `LOGO_MAX_WIDE` times as wide as tall. */
  | 'too-wide'
  /** More than `LOGO_MAX_TALL` times as tall as wide. */
  | 'too-tall'
  /** Nearly all of it is near-white: it would not show on the white background it is for. */
  | 'too-light'
  /** Nearly all of it is near-black: it would not show on the dark background it is for. */
  | 'too-dark'

export class ImagePipelineError extends Error {
  readonly problem: ImageProblem

  constructor(problem: ImageProblem) {
    super(`Image refused: ${problem}`)
    this.name = 'ImagePipelineError'
    this.problem = problem
  }
}

/** The problem of a failed preparation, or null when the error is something else. */
export function imageProblemOf(error: unknown): ImageProblem | null {
  return error instanceof ImagePipelineError ? error.problem : null
}

/**
 * The background a picture is for: `light` (the logo and the app icon: white cards, e-mails, paper)
 * or `dark` (the logo for dark surfaces: the shell, the dark colour scheme).
 */
export type Ground = 'light' | 'dark'

/** Where a picture is drawn on its canvas. */
export interface Placement {
  /** The canvas. */
  width: number
  height: number
  /** The picture on it. */
  x: number
  y: number
  drawWidth: number
  drawHeight: number
}

/**
 * A logo's first size: inside 1200 × 600, its proportions kept. A raster picture is only ever made
 * smaller (enlarging adds no detail); a vector one is drawn as large as the limits allow.
 */
export function workingSize(width: number, height: number, vector: boolean): { width: number; height: number } {
  const fit = Math.min(LOGO_LIMITS.maxWidth / width, LOGO_LIMITS.maxHeight / height)
  const scale = vector ? fit : Math.min(1, fit)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/**
 * A picture of `width` × `height` as a logo: at least 32 px each way and at most 1200 × 600. One
 * that is too small is enlarged as far as the limits allow, and a side that is still short (a
 * long, thin wordmark) gets transparent room, the picture centred.
 */
export function fitLogo(width: number, height: number): Placement {
  const { minWidth, maxWidth, minHeight, maxHeight } = LOGO_LIMITS
  const shrink = Math.min(1, maxWidth / width, maxHeight / height)
  let drawWidth = width * shrink
  let drawHeight = height * shrink
  if (drawWidth < minWidth || drawHeight < minHeight) {
    const grow = Math.min(Math.max(minWidth / drawWidth, minHeight / drawHeight), maxWidth / drawWidth, maxHeight / drawHeight)
    drawWidth *= grow
    drawHeight *= grow
  }
  drawWidth = Math.max(1, Math.round(drawWidth))
  drawHeight = Math.max(1, Math.round(drawHeight))
  const canvasWidth = Math.max(minWidth, drawWidth)
  const canvasHeight = Math.max(minHeight, drawHeight)
  return {
    width: canvasWidth,
    height: canvasHeight,
    x: Math.floor((canvasWidth - drawWidth) / 2),
    y: Math.floor((canvasHeight - drawHeight) / 2),
    drawWidth,
    drawHeight,
  }
}

/**
 * A picture on the square icon: contained in `share` of the tile, centred, its proportions kept.
 * The tile is as large as the picture allows inside 192–512 px.
 */
export function fitIcon(width: number, height: number, share: number = 1): Placement {
  const side = Math.min(ICON_LIMITS.max, Math.max(ICON_LIMITS.min, Math.round(Math.max(width, height) / share)))
  const box = side * share
  const scale = Math.min(box / width, box / height)
  const drawWidth = Math.max(1, Math.round(width * scale))
  const drawHeight = Math.max(1, Math.round(height * scale))
  return { width: side, height: side, x: Math.floor((side - drawWidth) / 2), y: Math.floor((side - drawHeight) / 2), drawWidth, drawHeight }
}

/** The pixels of a canvas: RGBA, row by row. */
export interface Raster {
  width: number
  height: number
  data: Uint8ClampedArray | readonly number[]
}

/** Pixels that may be changed in place (a canvas's own `ImageData`). */
export interface MutableRaster {
  width: number
  height: number
  data: Uint8ClampedArray | number[]
}

/** A pixel counts as drawn from this alpha on (of 255): a logo's soft edge belongs to it, a stray near-invisible one does not. */
const DRAWN_ALPHA = 8
/** At most this many pixels are read where a picture is only sampled: enough for the colours of any logo. */
const SAMPLE = 60_000

/**
 * The box around what is drawn in a picture (the pixels that are not transparent), so a logo saved
 * with empty room around it fills its place. Null when nothing is drawn.
 */
export function contentBounds({ width, height, data }: Raster): { x: number; y: number; width: number; height: number } | null {
  let left = width
  let right = -1
  let top = height
  let bottom = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3]! < DRAWN_ALPHA) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (right < 0) return null
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

/* ---- a flat background ------------------------------------------------------------------------- */

/** A picture is opaque (a JPEG, a scan, a flattened export) when no pixel is more transparent than this. */
const OPAQUE_ALPHA = 250
/** The edge pixels of a flat background are all this close to one colour (a JPEG's noise is a few levels). */
const FLAT_EDGE = 26
/** At least this share of the edge pixels: a speck of dust on a scan does not make a background a drawing. */
const FLAT_EDGE_SHARE = 0.995
/** What counts as the background while it is cleared from the edges inwards: this close to its colour. */
const BACKGROUND_REACH = 36
/** A white background's darkest channel is at least this; a black one's lightest is at most `255 -` this. */
const NEAR_WHITE = 236

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/**
 * Makes the flat background of a picture without transparency transparent, and answers whether it
 * did. Only when the picture is opaque and its four edges are one flat colour, near-white for a
 * picture meant for white backgrounds (near-black for one meant for dark ones): everything of that
 * colour that can be reached from the edges is cleared, and what is enclosed by the drawing (the
 * inside of a letter, a white cross in a red square) stays as it is. The pixels where the drawing
 * meets the background, which are a mix of the two, become partly transparent, so the drawing keeps
 * its soft edge instead of a fringe of the background's colour.
 *
 * A background of any other colour is left alone: it may be the logo's own tile, and what is drawn
 * on it (white letters, say) would not stand without it.
 */
export function clearFlatBackground({ width, height, data }: MutableRaster, ground: Ground): boolean {
  const pixels = width * height
  if (width < 3 || height < 3 || data.length < pixels * 4) return false
  for (let index = 0; index < pixels; index += 1) if (data[index * 4 + 3]! < OPAQUE_ALPHA) return false

  const edge: number[] = []
  for (let x = 0; x < width; x += 1) edge.push(x, (height - 1) * width + x)
  for (let y = 1; y < height - 1; y += 1) edge.push(y * width, y * width + width - 1)
  const background: Rgb = [0, 1, 2].map((channel) => median(edge.map((index) => data[index * 4 + channel]!))) as unknown as Rgb
  if (ground === 'light' ? Math.min(...background) < NEAR_WHITE : Math.max(...background) > 255 - NEAR_WHITE) return false
  const away = (index: number) => distance([data[index * 4]!, data[index * 4 + 1]!, data[index * 4 + 2]!], background)
  if (edge.filter((index) => away(index) <= FLAT_EDGE).length < edge.length * FLAT_EDGE_SHARE) return false

  // From the edges inwards: every pixel of the background's colour that touches one already cleared.
  const cleared = new Uint8Array(pixels)
  const queue = new Int32Array(pixels)
  let head = 0
  let tail = 0
  const visit = (index: number) => {
    if (cleared[index] === 1 || away(index) > BACKGROUND_REACH) return
    cleared[index] = 1
    queue[tail] = index
    tail += 1
  }
  for (const index of edge) visit(index)
  while (head < tail) {
    const index = queue[head]!
    head += 1
    const x = index % width
    if (x > 0) visit(index - 1)
    if (x < width - 1) visit(index + 1)
    if (index >= width) visit(index - width)
    if (index < pixels - width) visit(index + width)
  }

  // The drawing's rim: pixels beside a cleared one. Each is the drawing's colour (taken from the
  // strongest pixel next to it that is farther from the background) laid over the background at some
  // share; that share becomes its alpha, and the colour its own.
  const neighbours = (index: number): number[] => {
    const x = index % width
    const y = (index - x) / width
    const found: number[] = []
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if ((dx !== 0 || dy !== 0) && x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height) found.push(index + dy * width + dx)
      }
    }
    return found
  }
  const rim: { index: number; colour: Rgb; alpha: number }[] = []
  for (let index = 0; index < pixels; index += 1) {
    if (cleared[index] === 1) continue
    const around = neighbours(index)
    if (!around.some((other) => cleared[other] === 1)) continue
    const own = away(index)
    let inner = index
    let reach = own
    for (const other of around) {
      if (cleared[other] === 1) continue
      const far = away(other)
      if (far > reach) [inner, reach] = [other, far]
    }
    if (inner === index || reach <= 0) continue
    rim.push({ index, colour: [data[inner * 4]!, data[inner * 4 + 1]!, data[inner * 4 + 2]!], alpha: Math.min(1, own / reach) })
  }
  for (const { index, colour, alpha } of rim) {
    data[index * 4] = colour[0]
    data[index * 4 + 1] = colour[1]
    data[index * 4 + 2] = colour[2]
    data[index * 4 + 3] = Math.round(alpha * 255)
  }
  for (let index = 0; index < pixels; index += 1) if (cleared[index] === 1) data[index * 4 + 3] = 0
  return true
}

/* ---- what a picture is like -------------------------------------------------------------------- */

/** White on a colour lighter than this shows less than 1.25:1: on a white background it is not seen. */
const VANISHES_ON_WHITE = 0.79
/** A colour darker than this (about #303030) is not seen on the app's dark surfaces. */
const VANISHES_ON_DARK = 0.03
/**
 * "Nearly all" of a drawing on a transparent picture: this share of what is drawn. What is drawn
 * there is the logo's own shape, so a white wordmark with a small coloured mark beside it is still a
 * logo of which next to nothing shows on white.
 */
const NEARLY_ALL = 0.85
/**
 * Of a picture without transparency, all of it: it shows as a rectangle, and most of a rectangle
 * may well be its light background under a small dark drawing (a wordmark on cream).
 */
const ALL_OF_IT = 0.98
/** A picture is a rectangle (no transparency to speak of) when this share of it is drawn. */
const RECTANGLE = 0.98

/**
 * How much of what is drawn in a picture is near-white, and how much near-black (shares of its
 * drawn pixels, each counted by how opaque it is), and how much of the picture is drawn at all
 * (`cover`). Null when nothing is drawn.
 */
export function toneShares({ data }: Pick<Raster, 'data'>): { light: number; dark: number; cover: number } | null {
  const pixels = Math.floor(data.length / 4)
  const step = Math.max(1, Math.floor(pixels / SAMPLE))
  let read = 0
  let covered = 0
  let drawn = 0
  let light = 0
  let dark = 0
  for (let index = 0; index < pixels; index += step) {
    const offset = index * 4
    const alpha = data[offset + 3]!
    read += 1
    if (alpha < DRAWN_ALPHA) continue
    const weight = alpha / 255
    const brightness = luminance(toHex([data[offset]!, data[offset + 1]!, data[offset + 2]!]))
    covered += 1
    drawn += weight
    if (brightness > VANISHES_ON_WHITE) light += weight
    else if (brightness < VANISHES_ON_DARK) dark += weight
  }
  return drawn === 0 ? null : { light: light / drawn, dark: dark / drawn, cover: covered / read }
}

/** A picture that would not show on the background it is chosen for: nearly all of it is that background's colour. */
export function toneProblem(raster: Pick<Raster, 'data'>, ground: Ground): ImageProblem | null {
  const shares = toneShares(raster)
  if (!shares) return null
  const limit = shares.cover >= RECTANGLE ? ALL_OF_IT : NEARLY_ALL
  if (ground === 'light') return shares.light >= limit ? 'too-light' : null
  return shares.dark >= limit ? 'too-dark' : null
}

/**
 * A drawing of `width` × `height` px that cannot be shown well as a logo: too few pixels (a raster
 * picture only: a vector one is drawn at any size), a strip, or a column.
 */
export function shapeProblem(width: number, height: number, vector: boolean): ImageProblem | null {
  if (!vector && Math.max(width, height) < MIN_SOURCE_SIDE) return 'too-small'
  if (width > height * LOGO_MAX_WIDE) return 'too-wide'
  if (height > width * LOGO_MAX_TALL) return 'too-tall'
  return null
}

/* ---- the colours of a logo --------------------------------------------------------------------- */

/** Colours closer than this are one colour of the logo (an antialiased edge, a JPEG's noise). */
const SAME_COLOUR = 44
/** A colour that covers less than this share of the logo's coloured pixels is an edge, not a colour of the logo. */
const MINIMUM_SHARE = 0.02
/**
 * A very light or a very dark colour is one of the logo's only when much of the logo has it: under
 * this share it is what compression leaves around a shape (a pale halo on white, a dark rim), which
 * nobody would call the logo's colour.
 */
const MINIMUM_EXTREME_SHARE = 0.2
/** Two colours of nearly one hue, about as light and as vivid as each other, are one colour to the eye: the more used one stands for both. */
const SAME_HUE = 14
const SAME_LIGHTNESS = 0.14
const SAME_SATURATION = 0.3

/** Two colours a person would call the same: close in RGB, or of one hue and nearly one lightness. */
function alike(a: string, b: string): boolean {
  if (distance(toRgb(a), toRgb(b)) < SAME_COLOUR * 1.5) return true
  const [first, second] = [toHsl(a), toHsl(b)]
  // A grey has no hue to compare: greys are alike by lightness alone.
  const greys = first.saturation < 0.12 && second.saturation < 0.12
  const turn = Math.abs(first.hue - second.hue)
  const hues = greys || (first.saturation >= 0.12 && second.saturation >= 0.12 && Math.min(turn, 360 - turn) <= SAME_HUE)
  return hues && Math.abs(first.lightness - second.lightness) <= SAME_LIGHTNESS && Math.abs(first.saturation - second.saturation) <= SAME_SATURATION
}

/**
 * The colours of a logo, the most used and most vivid first, at most `limit` of them (`#rrggbb`).
 * Transparent, near-white and near-black pixels are left out (a background, a plate, black text):
 * what stays is what a person would call the logo's colours. Similar colours are counted as one,
 * named by its most used shade; a very light or very dark colour that only a little of the logo has
 * is left out (the pale halo a JPEG draws around a shape was offered as a colour of the logo).
 */
export function extractColours({ data }: Pick<Raster, 'data'>, limit = 5): string[] {
  const pixels = Math.floor(data.length / 4)
  const step = Math.max(1, Math.floor(pixels / SAMPLE))
  // 5 bits a channel: 32,768 shades at most.
  const shades = new Map<number, { count: number; r: number; g: number; b: number }>()
  let counted = 0
  for (let index = 0; index < pixels; index += step) {
    const offset = index * 4
    if (data[offset + 3]! < 128) continue
    const [r, g, b] = [data[offset]!, data[offset + 1]!, data[offset + 2]!]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    if (min >= 232 || max <= 30) continue
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const shade = shades.get(key)
    if (shade) {
      shade.count += 1
      shade.r += r
      shade.g += g
      shade.b += b
    } else {
      shades.set(key, { count: 1, r, g, b })
    }
    counted += 1
  }
  if (counted === 0) return []

  interface Cluster {
    /** The most used shade: the cluster's name. */
    colour: [number, number, number]
    count: number
  }
  const clusters: Cluster[] = []
  for (const shade of [...shades.values()].toSorted((a, b) => b.count - a.count)) {
    const colour: [number, number, number] = [shade.r / shade.count, shade.g / shade.count, shade.b / shade.count]
    const near = clusters.find((cluster) => distance(cluster.colour, colour) < SAME_COLOUR)
    if (near) near.count += shade.count
    else clusters.push({ colour, count: shade.count })
  }
  // Near-duplicates are one colour: the more used one (the clusters are in that order) takes the other's pixels.
  const colours: { hex: string; count: number }[] = []
  for (const cluster of clusters) {
    const hex = toHex(cluster.colour)
    const twin = colours.find((colour) => alike(colour.hex, hex))
    if (twin) twin.count += cluster.count
    else colours.push({ hex, count: cluster.count })
  }
  const scored = colours
    .filter(({ hex, count }) => {
      const share = count / counted
      if (share < MINIMUM_SHARE) return false
      const brightness = luminance(hex)
      return share >= MINIMUM_EXTREME_SHARE || (brightness <= VANISHES_ON_WHITE && brightness >= VANISHES_ON_DARK / 2)
    })
    // A vivid colour is the brand's rather than a grey of the same size.
    .map(({ hex, count }) => ({ hex, score: (count / counted) * (0.35 + toHsl(hex).saturation) }))
    .toSorted((a, b) => b.score - a.score)
  return [...new Set(scored.map((entry) => entry.hex))].slice(0, limit)
}

/* ------------------------------------------------------------------------------------------ */
/* The DOM part                                                                                */
/* ------------------------------------------------------------------------------------------ */

/** A picture ready to upload, and to show before it is. */
export interface PreparedAsset {
  /** The PNG that is uploaded: the canvas's own bytes. */
  blob: Blob
  width: number
  height: number
  /** The logo's colours, most used first (empty for an icon). */
  colours: string[]
  /** The drawing's width over its height, without the room around it (1 for an icon). */
  aspect: number
}

function isVector(file: Blob): boolean {
  return file.type === 'image/svg+xml' || /\.svgz?$/i.test((file as Partial<File>).name ?? '')
}

/** A length an SVG states (`width="120"`, `height="40px"`), as a positive number; else null. */
function statedLength(value: string | null): number | null {
  const parsed = value === null ? Number.NaN : Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** The size an SVG states for itself (its width and height, else its viewBox), when the browser gives the image none. */
async function vectorSize(file: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const root = new DOMParser().parseFromString(await file.text(), 'image/svg+xml').documentElement
    const [width, height] = [statedLength(root.getAttribute('width')), statedLength(root.getAttribute('height'))]
    if (width && height) return { width, height }
    const box = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
    if (box.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0) return { width: box[2]!, height: box[3]! }
  } catch {
    // Not an SVG the browser can read.
  }
  return null
}

interface Decoded {
  image: HTMLImageElement
  width: number
  height: number
  vector: boolean
  release: () => void
}

/** Lets the browser decode a file through an `<img>` (every image format it knows, SVG included). */
async function decode(file: Blob): Promise<Decoded> {
  if (file.size > MAX_SOURCE_BYTES) throw new ImagePipelineError('source-too-large')
  const url = URL.createObjectURL(file)
  const release = () => URL.revokeObjectURL(url)
  const image = new Image()
  image.decoding = 'async'
  try {
    await new Promise<void>((resolve, reject) => {
      image.addEventListener('load', () => resolve(), { once: true })
      image.addEventListener('error', () => reject(new ImagePipelineError('undecodable')), { once: true })
      image.src = url
    })
  } catch (error) {
    release()
    throw error
  }
  const vector = isVector(file)
  let width = image.naturalWidth
  let height = image.naturalHeight
  if (vector && (width === 0 || height === 0)) {
    const stated = await vectorSize(file)
    if (stated) ({ width, height } = stated)
  }
  if (!(width > 0 && height > 0)) {
    release()
    throw new ImagePipelineError('undecodable')
  }
  return { image, width, height, vector, release }
}

function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new ImagePipelineError('undecodable')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  return { canvas, context }
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new ImagePipelineError('undecodable'))), 'image/png')
  })
}

/**
 * A canvas as a PNG of at most 512 KiB: a picture that is heavier (a photograph as a logo) is drawn
 * smaller, a fifth at a time, down to `minimum` px on its shorter side; `too-heavy` when that is not
 * enough.
 */
async function encode(canvas: HTMLCanvasElement, minimum: number): Promise<{ blob: Blob; canvas: HTMLCanvasElement }> {
  let current = canvas
  for (;;) {
    const blob = await toPng(current)
    if (blob.size <= MAX_ASSET_BYTES) return { blob, canvas: current }
    const scale = 0.8
    if (Math.min(current.width, current.height) * scale < minimum) throw new ImagePipelineError('too-heavy')
    const smaller = canvasOf(Math.max(1, Math.round(current.width * scale)), Math.max(1, Math.round(current.height * scale)))
    smaller.context.drawImage(current, 0, 0, smaller.canvas.width, smaller.canvas.height)
    current = smaller.canvas
  }
}

/**
 * A chosen file as a logo for a `ground` (white backgrounds by default; dark ones for the logo for
 * dark surfaces): decoded by the browser, a flat background of that ground's colour made
 * transparent, the empty room around the drawing cut away, fitted inside the limits and encoded as
 * PNG, with the colours found in it. Refused, with the reason, when it is no picture, when nothing
 * is drawn in it, when its shape or its size cannot be shown well, and when it would not show on
 * the background it is for.
 */
export async function prepareLogo(file: Blob, ground: Ground = 'light'): Promise<PreparedAsset> {
  const decoded = await decode(file)
  try {
    const size = workingSize(decoded.width, decoded.height, decoded.vector)
    const work = canvasOf(size.width, size.height)
    work.context.drawImage(decoded.image, 0, 0, size.width, size.height)
    const pixels = work.context.getImageData(0, 0, size.width, size.height)
    if (clearFlatBackground(pixels, ground)) work.context.putImageData(pixels, 0, 0)
    const bounds = contentBounds(pixels)
    if (!bounds) throw new ImagePipelineError('empty')
    const problem = shapeProblem(bounds.width, bounds.height, decoded.vector) ?? toneProblem(pixels, ground)
    if (problem) throw new ImagePipelineError(problem)
    const placement = fitLogo(bounds.width, bounds.height)
    const fitted = canvasOf(placement.width, placement.height)
    fitted.context.drawImage(work.canvas, bounds.x, bounds.y, bounds.width, bounds.height, placement.x, placement.y, placement.drawWidth, placement.drawHeight)
    const { blob, canvas } = await encode(fitted.canvas, Math.max(LOGO_LIMITS.minWidth, LOGO_LIMITS.minHeight))
    const context = canvas.getContext('2d')
    const colours = context ? extractColours(context.getImageData(0, 0, canvas.width, canvas.height)) : []
    return { blob, width: canvas.width, height: canvas.height, colours, aspect: bounds.width / bounds.height }
  } finally {
    decoded.release()
  }
}

/** A picture on a white square: `share` of the tile for a logo, the whole tile for a picture chosen as the icon. */
async function squareIcon(decoded: Pick<Decoded, 'image' | 'width' | 'height'>, share: number): Promise<PreparedAsset> {
  const placement = fitIcon(decoded.width, decoded.height, share)
  const tile = canvasOf(placement.width, placement.height)
  tile.context.fillStyle = '#ffffff'
  tile.context.fillRect(0, 0, placement.width, placement.height)
  tile.context.drawImage(decoded.image, placement.x, placement.y, placement.drawWidth, placement.drawHeight)
  const { blob, canvas } = await encode(tile.canvas, ICON_LIMITS.min)
  return { blob, width: canvas.width, height: canvas.height, colours: [], aspect: 1 }
}

/**
 * A chosen file as the square icon: on white, as large as the tile. Refused when it is too small to
 * show sharply, and when it would be a blank tile (nearly all of it near-white).
 */
export async function prepareIcon(file: Blob): Promise<PreparedAsset> {
  const decoded = await decode(file)
  try {
    if (!decoded.vector && Math.max(decoded.width, decoded.height) < MIN_SOURCE_SIDE) throw new ImagePipelineError('too-small')
    const size = workingSize(decoded.width, decoded.height, decoded.vector)
    const work = canvasOf(size.width, size.height)
    work.context.drawImage(decoded.image, 0, 0, size.width, size.height)
    const pixels = work.context.getImageData(0, 0, size.width, size.height)
    if (!contentBounds(pixels)) throw new ImagePipelineError('empty')
    if (toneProblem(pixels, 'light')) throw new ImagePipelineError('too-light')
    return await squareIcon(decoded, 1)
  } finally {
    decoded.release()
  }
}

/** The square icon made from a prepared logo: the logo on a white tile, with room around it. */
export async function iconFromLogo(logo: Blob): Promise<PreparedAsset> {
  const decoded = await decode(logo)
  try {
    return await squareIcon(decoded, ICON_LOGO_SHARE)
  } finally {
    decoded.release()
  }
}

/** A square icon that is one letter on a colour. */
export interface LetterTile {
  /** One letter (or digit): the first of the company's name. */
  letter: string
  /** The tile: the company's surface colour, or the neutral one. */
  background: string
  /** The letter: the ink of that surface. */
  ink: string
}

/** The tile of a company without a colour: the slate of the app's neutral icons, under white. */
export const NEUTRAL_TILE = { background: '#33444e', ink: '#ffffff' } as const

/** The letter's share of the tile: the larger of its width and height. */
const LETTER_SHARE = 0.5
/** The app's own faces: Readex Pro has the Arabic and the Latin letters. */
const LETTER_FONT = '"Readex Pro", "Space Grotesk", system-ui, "Segoe UI", Tahoma, Arial, sans-serif'

function letterFont(size: number): string {
  return `700 ${Math.round(size)}px ${LETTER_FONT}`
}

/**
 * The square icon of a company whose logo is a wordmark: such a logo is a speck on a 16 px tile, so
 * the icon is the first letter of the company's name on its colour, as large as the tile holds.
 */
export async function letterIcon({ letter, background, ink }: LetterTile): Promise<PreparedAsset> {
  const side = ICON_LIMITS.max
  const { canvas, context } = canvasOf(side, side)
  context.fillStyle = background
  context.fillRect(0, 0, side, side)
  const trial = side * 0.5
  try {
    // The app's face may not have been used on this page yet: the canvas draws with it only once it is loaded.
    await document.fonts?.load(letterFont(trial), letter)
  } catch {
    // The browser's own face then.
  }
  context.font = letterFont(trial)
  context.textAlign = 'left'
  context.textBaseline = 'alphabetic'
  const measured = context.measureText(letter)
  const boxed = [measured.actualBoundingBoxLeft, measured.actualBoundingBoxRight, measured.actualBoundingBoxAscent, measured.actualBoundingBoxDescent].every(Number.isFinite)
  context.fillStyle = ink
  if (boxed && measured.actualBoundingBoxLeft + measured.actualBoundingBoxRight > 0 && measured.actualBoundingBoxAscent + measured.actualBoundingBoxDescent > 0) {
    // The letter's own ink, centred: a face's line box would set an Arabic letter and a capital off the middle.
    const scale = Math.min(1.5, (side * LETTER_SHARE) / Math.max(measured.actualBoundingBoxLeft + measured.actualBoundingBoxRight, measured.actualBoundingBoxAscent + measured.actualBoundingBoxDescent))
    context.font = letterFont(trial * scale)
    const drawn = context.measureText(letter)
    const width = drawn.actualBoundingBoxLeft + drawn.actualBoundingBoxRight
    const height = drawn.actualBoundingBoxAscent + drawn.actualBoundingBoxDescent
    context.fillText(letter, (side - width) / 2 + drawn.actualBoundingBoxLeft, (side - height) / 2 + drawn.actualBoundingBoxAscent)
  } else {
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(letter, side / 2, side / 2)
  }
  const { blob, canvas: encoded } = await encode(canvas, ICON_LIMITS.min)
  return { blob, width: encoded.width, height: encoded.height, colours: [], aspect: 1 }
}

/**
 * The colours of a logo the company already has (a same-origin address of the API's own file), for
 * the suggestions before any new file is chosen. Empty when it cannot be read.
 */
export async function coloursOfLogo(url: string): Promise<string[]> {
  const image = new Image()
  image.decoding = 'async'
  try {
    await new Promise<void>((resolve, reject) => {
      image.addEventListener('load', () => resolve(), { once: true })
      image.addEventListener('error', () => reject(new Error('The logo did not load')), { once: true })
      image.src = url
    })
    if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) return []
    const size = workingSize(image.naturalWidth, image.naturalHeight, false)
    const work = canvasOf(size.width, size.height)
    work.context.drawImage(image, 0, 0, size.width, size.height)
    return extractColours(work.context.getImageData(0, 0, size.width, size.height))
  } catch {
    return []
  }
}

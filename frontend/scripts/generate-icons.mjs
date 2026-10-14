/**
 * Generates the square app icons from the Mawdoo3 logo (phase 10, F10-8): the white wordmark
 * (public/brand/logo-white.png, 462 × 149, transparent) centred on the logo's teal (#169897),
 * using only Node built-ins: the PNG is decoded with zlib, resampled with 4 × 4 supersampling and
 * bilinear filtering (premultiplied alpha), and encoded again as PNG. Reproducible: the same
 * logo always gives the same bytes.
 *
 *   npm run icons
 *
 * - favicon-16.png / favicon-32.png / favicon-48.png: browser tabs. A tab draws the icon at 16 CSS
 *   px, where the whole wordmark was an unreadable smear (its letters about 4 px tall), so these
 *   show the compact mark instead: the logo's own «ع», the "3" of "Mawdoo3", as tall as the tile
 *   allows (rounded tile);
 * - icon-192.png / icon-512.png: the web manifest's `any` icons (rounded tile, the whole wordmark);
 * - icon-maskable-512.png: full-bleed square, the wordmark inside the central safe circle;
 * - apple-touch-icon.png: 180 px full-bleed square (iOS rounds the corners itself).
 *
 * These are the product's icons: only the platform owner's area links them (Phase 12). Every
 * other page starts with the neutral ones, drawn here too (neutral-16/32/48/192.png and
 * neutral-apple-touch-icon.png: a white visitor glyph on a slate tile), until a company's own
 * icon replaces them.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const TEAL = [0x16, 0x98, 0x97]
const SUPERSAMPLE = 4

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const outputDir = path.join(publicDir, 'icons')

/* ------------------------------------------------------------------------------------------ */
/* PNG decoding (8-bit RGBA, not interlaced: what the brand files are)                         */
/* ------------------------------------------------------------------------------------------ */

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

function decodePng(buffer) {
  let offset = 8
  let width = 0
  let height = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const [depth, colourType, , , interlace] = [data[8], data[9], data[10], data[11], data[12]]
      if (depth !== 8 || colourType !== 6 || interlace !== 0) throw new Error('Expected an 8-bit RGBA, non-interlaced PNG')
    } else if (type === 'IDAT') {
      idat.push(data)
    }
    offset += 12 + length
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x]
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter]
      if (predictor === undefined) throw new Error(`Unknown PNG filter ${filter}`)
      pixels[y * stride + x] = (value + predictor) & 0xff
    }
  }
  return { width, height, pixels }
}

/* ------------------------------------------------------------------------------------------ */
/* PNG encoding                                                                                */
/* ------------------------------------------------------------------------------------------ */

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    rows[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------------------------------ */
/* Rendering                                                                                   */
/* ------------------------------------------------------------------------------------------ */

const logo = decodePng(readFileSync(path.join(publicDir, 'brand', 'logo-white.png')))

/** The logo's premultiplied colour and alpha (0–1) at a point, bilinear; transparent outside it. */
function sampleLogo(x, y) {
  const fx = x - 0.5
  const fy = y - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const result = [0, 0, 0, 0]
  for (const [dx, dy, weight] of [
    [0, 0, (1 - tx) * (1 - ty)],
    [1, 0, tx * (1 - ty)],
    [0, 1, (1 - tx) * ty],
    [1, 1, tx * ty],
  ]) {
    const px = x0 + dx
    const py = y0 + dy
    if (weight === 0 || px < 0 || py < 0 || px >= logo.width || py >= logo.height) continue
    const offset = (py * logo.width + px) * 4
    const alpha = logo.pixels[offset + 3] / 255
    result[0] += (logo.pixels[offset] / 255) * alpha * weight
    result[1] += (logo.pixels[offset + 1] / 255) * alpha * weight
    result[2] += (logo.pixels[offset + 2] / 255) * alpha * weight
    result[3] += alpha * weight
  }
  return result
}

/** `sampleLogo`, transparent outside `region` (so a neighbouring letter never bleeds into a crop). */
function sampleRegion(region, x, y) {
  if (x < region.x || y < region.y || x >= region.x + region.width || y >= region.y + region.height) return [0, 0, 0, 0]
  return sampleLogo(x, y)
}

function insideRoundedSquare(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius)
  const cy = Math.min(Math.max(y, radius), size - radius)
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
}

/** The whole wordmark. */
const WORDMARK = { x: 0, y: 0, width: logo.width, height: logo.height }

/**
 * The compact mark for tab-sized icons: the wordmark's last letter, «ع» (logo pixels 7–68 across,
 * 34–141 down: its own connected shape, nothing else of the logo inside the box), with a 1 px
 * margin so its antialiased edge is kept whole.
 */
const COMPACT_MARK = { x: 6, y: 33, width: 64, height: 110 }

/**
 * @param size output pixels
 * @param variant 'rounded' (transparent corners, purpose "any") or 'full' (full-bleed square)
 * @param fit the part of the logo drawn (`region`, default the wordmark) and its size: `width` or
 *   `height` as a share of the icon; centred
 */
function renderIcon(size, variant, { region = WORDMARK, width, height }) {
  const pixels = Buffer.alloc(size * size * 4)
  // Logo pixels per icon pixel.
  const scale = width !== undefined ? region.width / (size * width) : region.height / (size * height)
  const drawnWidth = region.width / scale
  const drawnHeight = region.height / scale
  const left = (size - drawnWidth) / 2 - region.x / scale
  const top = (size - drawnHeight) / 2 - region.y / scale
  const radius = size * (112 / 512)
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = px + (sx + 0.5) / SUPERSAMPLE
          const y = py + (sy + 0.5) / SUPERSAMPLE
          if (variant === 'rounded' && !insideRoundedSquare(x, y, size, radius)) continue
          const [lr, lg, lb, la] = sampleRegion(region, (x - left) * scale, (y - top) * scale)
          // White logo over the teal tile (premultiplied "over").
          r += lr * 255 + TEAL[0] * (1 - la)
          g += lg * 255 + TEAL[1] * (1 - la)
          b += lb * 255 + TEAL[2] * (1 - la)
          a += 1
        }
      }
      const offset = (py * size + px) * 4
      pixels[offset] = a ? Math.round(r / a) : 0
      pixels[offset + 1] = a ? Math.round(g / a) : 0
      pixels[offset + 2] = a ? Math.round(b / a) : 0
      pixels[offset + 3] = Math.round((a / (SUPERSAMPLE * SUPERSAMPLE)) * 255)
    }
  }
  return encodePng(size, size, pixels)
}

/* ------------------------------------------------------------------------------------------ */
/* The neutral icons (Phase 12)                                                                */
/* ------------------------------------------------------------------------------------------ */

/** The neutral tile: mawdoo3.com's slate is nobody's logo colour. */
const SLATE = [0x33, 0x44, 0x4e]

/**
 * Whether a point of the unit square lies in the neutral glyph, a visitor: a head over shoulders
 * (a circle over the upper half of an ellipse), readable at 16 px.
 */
function insideVisitorGlyph(u, v) {
  const head = (u - 0.5) ** 2 + (v - 0.36) ** 2 <= 0.15 ** 2
  const shoulders = v >= 0.58 && v <= 0.8 && ((u - 0.5) / 0.29) ** 2 + ((v - 0.8) / 0.22) ** 2 <= 1
  return head || shoulders
}

/**
 * The icon of a page that is nobody's (the sign-in page without a company, a company that has no
 * icon of its own): a white visitor glyph on a slate tile, no logo and no name.
 */
function renderNeutralIcon(size, variant) {
  const pixels = Buffer.alloc(size * size * 4)
  const radius = size * (112 / 512)
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = px + (sx + 0.5) / SUPERSAMPLE
          const y = py + (sy + 0.5) / SUPERSAMPLE
          if (variant === 'rounded' && !insideRoundedSquare(x, y, size, radius)) continue
          const glyph = insideVisitorGlyph(x / size, y / size)
          r += glyph ? 255 : SLATE[0]
          g += glyph ? 255 : SLATE[1]
          b += glyph ? 255 : SLATE[2]
          a += 1
        }
      }
      const offset = (py * size + px) * 4
      pixels[offset] = a ? Math.round(r / a) : 0
      pixels[offset + 1] = a ? Math.round(g / a) : 0
      pixels[offset + 2] = a ? Math.round(b / a) : 0
      pixels[offset + 3] = Math.round((a / (SUPERSAMPLE * SUPERSAMPLE)) * 255)
    }
  }
  return encodePng(size, size, pixels)
}

const outputs = [
  // Neutral: what `index.html` links, so a company's or a visitor's tab never starts with the product's mark.
  ['neutral-16.png', renderNeutralIcon(16, 'rounded')],
  ['neutral-32.png', renderNeutralIcon(32, 'rounded')],
  ['neutral-48.png', renderNeutralIcon(48, 'rounded')],
  ['neutral-192.png', renderNeutralIcon(192, 'rounded')],
  ['neutral-apple-touch-icon.png', renderNeutralIcon(180, 'full')],
  // The compact mark, 72 % of the tile's height (11.5 px of 16, 23 of 32).
  ['favicon-16.png', renderIcon(16, 'rounded', { region: COMPACT_MARK, height: 0.72 })],
  ['favicon-32.png', renderIcon(32, 'rounded', { region: COMPACT_MARK, height: 0.72 })],
  ['favicon-48.png', renderIcon(48, 'rounded', { region: COMPACT_MARK, height: 0.7 })],
  ['icon-192.png', renderIcon(192, 'rounded', { width: 0.78 })],
  ['icon-512.png', renderIcon(512, 'rounded', { width: 0.78 })],
  // Maskable: the content must fit the central circle of 40 % radius; the wordmark's corners
  // stay inside it at 70 % of the width (half-diagonal 0.368).
  ['icon-maskable-512.png', renderIcon(512, 'full', { width: 0.7 })],
  ['apple-touch-icon.png', renderIcon(180, 'full', { width: 0.76 })],
]

mkdirSync(outputDir, { recursive: true })
for (const [name, png] of outputs) {
  writeFileSync(path.join(outputDir, name), png)
  console.log(`wrote public/icons/${name} (${png.length} bytes)`)
}

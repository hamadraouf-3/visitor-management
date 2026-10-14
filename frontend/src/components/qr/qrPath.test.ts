// @vitest-environment node
import { readFileSync } from 'node:fs'
import { create } from 'qrcode'
import { beforeAll, describe, expect, it } from 'vitest'
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'
import { parsePassToken } from '../../scanner/parsePassToken'
import { qrMatrixPath } from './qrPath'

const TOKEN = 'Xo3_vK9-aQ2rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2A'
const PASS_URL = `https://visitors.example.com/pass#${TOKEN}`

/** Rasterises the SVG path (horizontal runs "M{x} {y}h{w}v1h-{w}z") the way a screen would. */
function rasterise(d: string, size: number, margin = 4, scale = 4) {
  const width = (size + margin * 2) * scale
  const data = new Uint8ClampedArray(width * width * 4).fill(255)
  for (const match of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, run] = [Number(match[1]), Number(match[2]), Number(match[3])]
    for (let py = (y + margin) * scale; py < (y + margin + 1) * scale; py += 1) {
      for (let px = (x + margin) * scale; px < (x + margin + run) * scale; px += 1) {
        const offset = (py * width + px) * 4
        data[offset] = 0
        data[offset + 1] = 0
        data[offset + 2] = 0
      }
    }
  }
  return { data, width, height: width, colorSpace: 'srgb' as const }
}

describe('qrMatrixPath', () => {
  beforeAll(() => {
    const wasm = readFileSync(new URL('../../../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', import.meta.url))
    prepareZXingModule({ overrides: { wasmBinary: new Uint8Array(wasm).buffer } })
  })

  it('covers exactly the dark modules of the encoded symbol', () => {
    const { size, d } = qrMatrixPath(PASS_URL)
    const { modules } = create(PASS_URL, { errorCorrectionLevel: 'M' })
    const darkModules = Array.from(modules.data).filter(Boolean).length
    const pathModules = Array.from(d.matchAll(/h(\d+)v1/g)).reduce((sum, match) => sum + Number(match[1]), 0)

    expect(size).toBe(modules.size)
    expect(pathModules).toBe(darkModules)
  })

  it('decodes back to the pass URL, which the scanner parser accepts', async () => {
    const { size, d } = qrMatrixPath(PASS_URL)

    const [result] = await readBarcodes(rasterise(d, size), { formats: ['QRCode'] })

    expect(result?.text).toBe(PASS_URL)
    expect(parsePassToken(result?.text ?? '')).toBe(TOKEN)
  })
})

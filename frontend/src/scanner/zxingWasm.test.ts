// @vitest-environment node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ZXING_WASM_SHA256, ZXING_WASM_VERSION } from 'barcode-detector/ponyfill'
import { describe, expect, it } from 'vitest'

const zxingPackage = new URL('../../node_modules/zxing-wasm/', import.meta.url)

describe('self-hosted zxing wasm', () => {
  // barcode-detector bundles the zxing JS glue; the .wasm we serve must be the exact build it expects.
  it('is the zxing-wasm version the barcode-detector glue was built for', () => {
    const { version } = JSON.parse(readFileSync(new URL('package.json', zxingPackage), 'utf8')) as { version: string }
    expect(version).toBe(ZXING_WASM_VERSION)
  })

  it('is byte-identical to the wasm the glue expects (SHA-256)', () => {
    const wasm = readFileSync(new URL('dist/reader/zxing_reader.wasm', zxingPackage))
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(ZXING_WASM_SHA256)
  })
})

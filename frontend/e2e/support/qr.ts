import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader'

/*
 * QR decoding in the test process with the zxing-wasm build the app itself ships (node_modules).
 * The WebAssembly binary is handed over directly, so nothing is fetched (the package's default
 * locateFile would load it from a CDN).
 */

const require = createRequire(import.meta.url)
let ready: Promise<unknown> | null = null

function ensureModule(): Promise<unknown> {
  if (!ready) {
    const wasm = readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'))
    const wasmBinary = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer
    ready = prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true })
  }
  return ready
}

/** Every QR code in an encoded image (PNG, JPEG…), as text. */
export async function decodeQrImage(image: Uint8Array): Promise<string[]> {
  await ensureModule()
  const results = await readBarcodes(new Uint8Array(image), { formats: ['QRCode'], tryHarder: true })
  return results.filter((result) => result.isValid).map((result) => result.text)
}

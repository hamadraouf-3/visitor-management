import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ponyfill = vi.hoisted(() => {
  const prepareZXingModule = vi.fn<(options: unknown) => Promise<unknown>>(() => Promise.resolve({}))
  class BarcodeDetector {
    readonly options: { formats?: string[] }
    constructor(options: { formats?: string[] }) {
      this.options = options
    }
    detect() {
      return Promise.resolve([])
    }
  }
  return { prepareZXingModule, BarcodeDetector }
})

vi.mock('barcode-detector/ponyfill', () => ponyfill)
// The test setup replaces the decoder module everywhere else; this file tests the real one.
vi.unmock('./zxing')

const { configureZXing, createQrDetector, preloadQrDecoder, supportsNativeQrDetection, ZXING_MODULE_OVERRIDES, ZXING_WASM_URL } =
  await import('./zxing')

class NativeBarcodeDetector {
  static formats: string[] | Error = ['qr_code', 'ean_13']
  static getSupportedFormats() {
    return this.formats instanceof Error ? Promise.reject(this.formats) : Promise.resolve(this.formats)
  }
  readonly options: { formats?: string[] }
  constructor(options: { formats?: string[] }) {
    this.options = options
  }
  detect() {
    return Promise.resolve([])
  }
}

describe('zxing decoder configuration', () => {
  beforeEach(() => {
    ponyfill.prepareZXingModule.mockClear()
    NativeBarcodeDetector.formats = ['qr_code', 'ean_13']
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('self-hosts the wasm: a same-origin asset URL, never a CDN', () => {
    expect(ZXING_WASM_URL).toMatch(/zxing_reader[^/]*\.wasm$/)
    expect(ZXING_WASM_URL).not.toMatch(/^https?:\/\//)
    expect(ZXING_WASM_URL).not.toContain('jsdelivr')
  })

  it('points locateFile at the self-hosted wasm and leaves other files alone', () => {
    configureZXing()

    expect(ponyfill.prepareZXingModule).toHaveBeenCalledWith({ overrides: ZXING_MODULE_OVERRIDES })
    expect(ZXING_MODULE_OVERRIDES.locateFile('zxing_reader.wasm', 'https://cdn.example/')).toBe(ZXING_WASM_URL)
    expect(ZXING_MODULE_OVERRIDES.locateFile('worker.js', '/assets/')).toBe('/assets/worker.js')
  })

  it('reuses one overrides object so the module is not re-instantiated', () => {
    configureZXing()
    configureZXing()

    const [first, second] = ponyfill.prepareZXingModule.mock.calls.map(([options]) => (options as { overrides: unknown }).overrides)
    expect(first).toBe(second)
  })

  it('preloads the wasm eagerly when no native detector exists', async () => {
    vi.stubGlobal('BarcodeDetector', undefined)

    await expect(preloadQrDecoder()).resolves.toBe('zxing')
    expect(ponyfill.prepareZXingModule).toHaveBeenCalledWith({ overrides: ZXING_MODULE_OVERRIDES, fireImmediately: true })
  })

  it('uses the native BarcodeDetector only when it supports qr_code', async () => {
    vi.stubGlobal('BarcodeDetector', NativeBarcodeDetector)

    expect(await supportsNativeQrDetection()).toBe(true)
    await expect(preloadQrDecoder()).resolves.toBe('native')
    const { engine, detector } = await createQrDetector()

    expect(engine).toBe('native')
    expect(detector).toBeInstanceOf(NativeBarcodeDetector)
    expect((detector as NativeBarcodeDetector).options).toEqual({ formats: ['qr_code'] })
    expect(ponyfill.prepareZXingModule).not.toHaveBeenCalled()
  })

  it('falls back to the ponyfill when the native detector lacks qr_code', async () => {
    NativeBarcodeDetector.formats = ['ean_13']
    vi.stubGlobal('BarcodeDetector', NativeBarcodeDetector)

    const { engine, detector } = await createQrDetector()

    expect(engine).toBe('zxing')
    expect(detector).toBeInstanceOf(ponyfill.BarcodeDetector)
    expect((detector as InstanceType<typeof ponyfill.BarcodeDetector>).options).toEqual({ formats: ['qr_code'] })
    expect(ponyfill.prepareZXingModule).toHaveBeenCalledWith({ overrides: ZXING_MODULE_OVERRIDES })
  })

  it('falls back to the ponyfill when the native detector fails to report formats', async () => {
    NativeBarcodeDetector.formats = new Error('not supported')
    vi.stubGlobal('BarcodeDetector', NativeBarcodeDetector)

    expect(await supportsNativeQrDetection()).toBe(false)
    expect((await createQrDetector()).engine).toBe('zxing')
  })
})

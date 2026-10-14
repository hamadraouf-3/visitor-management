import {
  BarcodeDetector as ZXingBarcodeDetector,
  prepareZXingModule,
  type DetectedBarcode,
} from 'barcode-detector/ponyfill'
// Self-hosted decoder: emitted as a hashed asset and precached by the service worker.
// barcode-detector's default would fetch it from jsDelivr, which the CSP and offline LANs forbid.
import zxingReaderWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

export type QrDecoderEngine = 'native' | 'zxing'

/** The subset of the Barcode Detection API the scanner uses. */
export interface QrDetector {
  detect(source: ImageBitmapSource): Promise<Pick<DetectedBarcode, 'rawValue'>[]>
}

interface NativeBarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): QrDetector
  getSupportedFormats(): Promise<readonly string[]>
}

export const ZXING_WASM_URL: string = zxingReaderWasmUrl

/**
 * One stable overrides object: zxing compares overrides shallowly to decide whether the
 * module must be re-instantiated, so a fresh object per call would reload the wasm.
 */
export const ZXING_MODULE_OVERRIDES = {
  locateFile: (path: string, prefix: string): string => (path.endsWith('.wasm') ? ZXING_WASM_URL : prefix + path),
}

function nativeBarcodeDetector(): NativeBarcodeDetectorConstructor | undefined {
  return (globalThis as { BarcodeDetector?: NativeBarcodeDetectorConstructor }).BarcodeDetector
}

/** The native BarcodeDetector is used only when it exists and supports `qr_code` (§3). */
export async function supportsNativeQrDetection(): Promise<boolean> {
  const NativeDetector = nativeBarcodeDetector()
  if (!NativeDetector) return false
  try {
    const formats = await NativeDetector.getSupportedFormats()
    return formats.includes('qr_code')
  } catch {
    return false
  }
}

/** Configures the zxing ponyfill to load the self-hosted wasm (lazily, on first decode). */
export function configureZXing(): void {
  prepareZXingModule({ overrides: ZXING_MODULE_OVERRIDES })
}

/**
 * Downloads and instantiates the decoder ahead of the first scan (call when /reception
 * mounts, §10). A no-op when the native detector will be used.
 */
export async function preloadQrDecoder(): Promise<QrDecoderEngine> {
  if (await supportsNativeQrDetection()) return 'native'
  await prepareZXingModule({ overrides: ZXING_MODULE_OVERRIDES, fireImmediately: true })
  return 'zxing'
}

/** A QR-only detector: native when supported, otherwise the self-hosted zxing ponyfill. */
export async function createQrDetector(): Promise<{ engine: QrDecoderEngine; detector: QrDetector }> {
  const NativeDetector = nativeBarcodeDetector()
  if (NativeDetector && (await supportsNativeQrDetection())) {
    return { engine: 'native', detector: new NativeDetector({ formats: ['qr_code'] }) }
  }
  configureZXing()
  return { engine: 'zxing', detector: new ZXingBarcodeDetector({ formats: ['qr_code'] }) }
}

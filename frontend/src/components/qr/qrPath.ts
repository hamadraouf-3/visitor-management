import { create, type QRCodeErrorCorrectionLevel } from 'qrcode'

export interface QrMatrixPath {
  /** Modules per side (without quiet zone). */
  size: number
  /** SVG path covering every dark module, one horizontal run per segment. */
  d: string
}

/** Encodes `value` and returns an SVG path of its dark modules (no canvas, CSP-safe). */
export function qrMatrixPath(value: string, errorCorrectionLevel: QRCodeErrorCorrectionLevel = 'M'): QrMatrixPath {
  const { modules } = create(value, { errorCorrectionLevel })
  const { size } = modules
  const segments: string[] = []
  for (let row = 0; row < size; row += 1) {
    let column = 0
    while (column < size) {
      if (!modules.get(row, column)) {
        column += 1
        continue
      }
      const start = column
      while (column < size && modules.get(row, column)) column += 1
      segments.push(`M${start} ${row}h${column - start}v1h${start - column}z`)
    }
  }
  return { size, d: segments.join('') }
}

import type { QRCodeErrorCorrectionLevel } from 'qrcode'
import { useMemo } from 'react'
import { cn } from '../../utils/cn'
import { qrMatrixPath } from './qrPath'

export interface QrCodeProps {
  value: string
  /** Accessible name, e.g. "Visitor pass QR code". */
  label: string
  errorCorrectionLevel?: QRCodeErrorCorrectionLevel
  /** Quiet zone in modules; scanners need at least 4. */
  margin?: number
  className?: string
}

/**
 * QR code rendered as inline SVG from the `qrcode` module matrix: crisp at any size,
 * printable, and needs no canvas, data URL or inline style (strict CSP). Always black on
 * white regardless of theme, which scanners require.
 */
export function QrCode({ value, label, errorCorrectionLevel = 'M', margin = 4, className }: QrCodeProps) {
  const { size, d } = useMemo(() => qrMatrixPath(value, errorCorrectionLevel), [value, errorCorrectionLevel])
  const extent = size + margin * 2

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${extent} ${extent}`}
      shapeRendering="crispEdges"
      className={cn('block aspect-square h-auto w-full', className)}
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={d} fill="#000000" transform={`translate(${margin} ${margin})`} />
    </svg>
  )
}

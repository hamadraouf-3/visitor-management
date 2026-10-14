import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../utils/cn'

type SpinnerSize = 'sm' | 'md' | 'lg'

const sizeClasses: Record<SpinnerSize, string> = {
  sm: 'size-4',
  md: 'size-5',
  lg: 'size-8',
}

interface SpinnerProps {
  size?: SpinnerSize
  /** Announced to assistive technology; "Loading…" in the UI language by default. */
  label?: string
  /** Visual only (e.g. inside a button that already sets aria-busy). */
  decorative?: boolean
  /** Show the label next to the icon. */
  showLabel?: boolean
  className?: string
}

/** Rotation is disabled under prefers-reduced-motion (see index.css); the label still conveys state. */
export function Spinner({ size = 'md', label, decorative = false, showLabel = false, className }: SpinnerProps) {
  const { t } = useTranslation()
  const icon = <LoaderCircle aria-hidden="true" className={cn('shrink-0 animate-spin', sizeClasses[size])} />
  if (decorative) return <span className={cn('inline-flex', className)}>{icon}</span>

  return (
    <span role="status" className={cn('inline-flex items-center gap-2 text-fg-muted', className)}>
      {icon}
      <span className={showLabel ? 'text-sm' : 'sr-only'}>{label ?? t('app.loading')}</span>
    </span>
  )
}

/** Centered loading state for a page or panel. */
export function PageSpinner({ label }: { label?: string }) {
  return (
    <div className="flex min-h-48 w-full items-center justify-center p-8">
      <Spinner size="lg" label={label} showLabel />
    </div>
  )
}

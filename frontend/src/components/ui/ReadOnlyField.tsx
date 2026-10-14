import type { ReactNode } from 'react'
import { cn } from '../../utils/cn'

export interface ReadOnlyFieldProps {
  label: ReactNode
  /** The value, as text: give an address to `EmailText`, a code a `dir="ltr"` element. */
  children: ReactNode
  className?: string
}

/**
 * A value under its label where a form would have a field (an account's e-mail address beside the
 * password to hand over), as text in a box that grows with it. Never a read-only input for this: an
 * input shows one line, and a long address was cut off at a phone's width with no way to read its
 * end (UX review L14). The text can be selected and copied.
 */
export function ReadOnlyField({ label, children, className }: ReadOnlyFieldProps) {
  return (
    <dl className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <dt className="text-sm font-semibold text-fg">{label}</dt>
      <dd data-read-only-value="" className="min-h-11 rounded-control border border-border bg-surface-sunken px-3.5 py-2 text-base break-words text-fg">
        {children}
      </dd>
    </dl>
  )
}

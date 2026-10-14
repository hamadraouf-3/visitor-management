import { ChevronDown } from 'lucide-react'
import type { ComponentPropsWithRef } from 'react'
import { cn } from '../../utils/cn'
import { controlClassName, useControlA11yProps } from './fieldContext'

export interface SelectProps extends ComponentPropsWithRef<'select'> {
  invalid?: boolean
}

/** Native select (best on touch devices and with assistive technology), restyled. */
export function Select({
  className,
  invalid,
  id,
  children,
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid,
  ...rest
}: SelectProps) {
  const a11y = useControlA11yProps({ id, 'aria-describedby': describedBy, 'aria-invalid': ariaInvalid, invalid })
  return (
    <div className={cn('relative', className)}>
      <select {...rest} {...a11y} className={cn(controlClassName, 'appearance-none pe-10')}>
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute end-3.5 top-1/2 size-4 -translate-y-1/2 text-fg-muted"
      />
    </div>
  )
}

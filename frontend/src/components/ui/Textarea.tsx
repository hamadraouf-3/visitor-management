import type { ComponentPropsWithRef } from 'react'
import { cn } from '../../utils/cn'
import { controlClassName, useControlA11yProps } from './fieldContext'

export interface TextareaProps extends ComponentPropsWithRef<'textarea'> {
  invalid?: boolean
}

export function Textarea({
  className,
  invalid,
  id,
  rows = 3,
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid,
  ...rest
}: TextareaProps) {
  const a11y = useControlA11yProps({ id, 'aria-describedby': describedBy, 'aria-invalid': ariaInvalid, invalid })
  return <textarea {...rest} {...a11y} rows={rows} className={cn(controlClassName, 'resize-y', className)} />
}

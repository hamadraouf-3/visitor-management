import type { ComponentPropsWithRef } from 'react'
import { cn } from '../../utils/cn'
import { controlClassName, useControlA11yProps } from './fieldContext'

export interface InputProps extends ComponentPropsWithRef<'input'> {
  /** Overrides the invalid state derived from the surrounding Field. */
  invalid?: boolean
}

export function Input({ className, invalid, id, 'aria-describedby': describedBy, 'aria-invalid': ariaInvalid, ...rest }: InputProps) {
  const a11y = useControlA11yProps({ id, 'aria-describedby': describedBy, 'aria-invalid': ariaInvalid, invalid })
  return <input {...rest} {...a11y} className={cn(controlClassName, className)} />
}

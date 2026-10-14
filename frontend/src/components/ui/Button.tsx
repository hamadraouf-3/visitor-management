import type { ComponentPropsWithRef, MouseEvent, ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router'
import { buttonClassName, type ButtonSize, type ButtonVariant } from './buttonStyles'
import { Spinner } from './Spinner'

export interface ButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'aria-disabled' | 'aria-busy'> {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
  /**
   * The action is running: shows a spinner in place of the icon and ignores activation, but
   * stays focusable (`aria-disabled` + `aria-busy`), so focus is still on the button when
   * the action ends. Use it for the button that started the action (e.g. a form's submit).
   */
  loading?: boolean
  /**
   * With `disabled`: unavailable but still focusable (`aria-disabled`) instead of natively
   * disabled. Use it for a button that can become disabled while it has focus (e.g. "Next"
   * on the second-to-last page), where the native attribute would drop focus to the page.
   */
  focusableWhenDisabled?: boolean
  /** Leading icon (decorative). */
  icon?: ReactNode
}

/**
 * Native `disabled` is kept for buttons that are unavailable before anyone can focus them.
 * A button that becomes unavailable while focused (its own action is running, a boundary
 * was reached) must stay focusable: browsers move focus from a newly disabled element to
 * the document body, so keyboard and screen-reader users would start over from the top.
 */
export function Button({
  variant,
  size,
  fullWidth,
  loading = false,
  focusableWhenDisabled = false,
  icon,
  className,
  children,
  disabled = false,
  type = 'button',
  onClick,
  ...rest
}: ButtonProps) {
  const unavailableButFocusable = loading || (disabled && focusableWhenDisabled)

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (unavailableButFocusable) {
      // Cancels the default action as well, so a submit button does not submit its form
      // (also when implicit submission clicks it after Enter in a text field).
      event.preventDefault()
      return
    }
    onClick?.(event)
  }

  return (
    <button
      {...rest}
      type={type}
      className={buttonClassName({ variant, size, fullWidth, className })}
      disabled={disabled && !unavailableButFocusable}
      aria-disabled={unavailableButFocusable || undefined}
      aria-busy={loading || undefined}
      onClick={handleClick}
    >
      {loading ? <Spinner size="sm" decorative /> : icon}
      {children}
    </button>
  )
}

export interface ButtonLinkProps extends LinkProps {
  variant?: ButtonVariant
  size?: ButtonSize
  fullWidth?: boolean
  icon?: ReactNode
}

/** A router link styled as a button (navigation, not actions). */
export function ButtonLink({ variant, size, fullWidth, icon, className, children, ...rest }: ButtonLinkProps) {
  return (
    <Link className={buttonClassName({ variant, size, fullWidth, className })} {...rest}>
      {icon}
      {children}
    </Link>
  )
}

import { Check, Copy } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../utils/cn'
import { copyText } from '../../utils/clipboard'
import { Button, type ButtonProps } from './Button'

/** How long the "copied" confirmation stays before the button resets. */
export const COPY_CONFIRMATION_MS = 2000

export interface CopyButtonProps extends Omit<ButtonProps, 'onClick' | 'children' | 'loading' | 'icon' | 'value'> {
  /** Text placed on the clipboard (e.g. the one-time pass link). */
  value: string
  /** Button text ("Copy" in the UI language by default). */
  label?: string
  /** Button text and announcement after a successful copy, e.g. "Link copied" ("Copied" by default). */
  copiedLabel?: string
  /** Shown and announced when copying is impossible (no clipboard access). */
  failureMessage?: string
  onCopied?: () => void
}

type CopyState = 'idle' | 'copied' | 'failed'

/**
 * Copies `value` to the clipboard. Success switches the button to a check mark and
 * `copiedLabel` for two seconds; success and failure are announced through a polite live
 * region that is mounted from the first render (late-inserted regions are often missed).
 */
export function CopyButton({
  value,
  label,
  copiedLabel,
  failureMessage,
  onCopied,
  variant = 'secondary',
  className,
  ...buttonProps
}: CopyButtonProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<CopyState>('idle')

  useEffect(() => {
    if (state !== 'copied') return
    const timer = window.setTimeout(() => setState('idle'), COPY_CONFIRMATION_MS)
    return () => window.clearTimeout(timer)
  }, [state])

  const handleClick = async () => {
    const copied = await copyText(value)
    setState(copied ? 'copied' : 'failed')
    if (copied) onCopied?.()
  }

  const copied = state === 'copied'
  const copiedText = copiedLabel ?? t('actions.copied')
  const failureText = failureMessage ?? t('actions.copyFailed')
  return (
    <span
      className={cn('flex-col gap-1', buttonProps.fullWidth ? 'flex w-full items-stretch' : 'inline-flex items-start', className)}
    >
      <Button
        {...buttonProps}
        variant={variant}
        icon={copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        onClick={() => void handleClick()}
      >
        {copied ? copiedText : (label ?? t('actions.copy'))}
      </Button>
      <span role="status" className={state === 'failed' ? 'text-sm text-danger-text' : 'sr-only'}>
        {copied ? copiedText : state === 'failed' ? failureText : ''}
      </span>
    </span>
  )
}

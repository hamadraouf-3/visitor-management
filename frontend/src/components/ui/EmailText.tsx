import { Fragment } from 'react'
import { emailBreakParts } from '../../utils/email'
import { cn } from '../../utils/cn'
import type { TextPart } from '../../utils/text'

/** A sentence whose email addresses wrap at their separators (see `TextPart`). */
export function TextWithEmails({ parts }: { parts: readonly TextPart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        typeof part === 'string' ? <Fragment key={index}>{part}</Fragment> : <EmailText key={index} address={part.email} />,
      )}
    </>
  )
}

export interface EmailTextProps {
  address: string
  /**
   * `wrap` (default): may break after the `@` and before the dots of the domain, and only
   * inside a part when nothing else fits. `truncate`: one line with an ellipsis; the full
   * address is the element's title (table cells).
   */
  overflow?: 'wrap' | 'truncate'
  className?: string
}

/**
 * An email address that never breaks mid-word where it could break at its separators. It is
 * isolated left to right (`dir="ltr"`), so in Arabic text its parts and any punctuation after it
 * stay in place.
 */
export function EmailText({ address, overflow = 'wrap', className }: EmailTextProps) {
  if (overflow === 'truncate') {
    return (
      <span dir="ltr" title={address} className={cn('block max-w-full truncate', className)}>
        {address}
      </span>
    )
  }
  return (
    <span dir="ltr" className={cn('wrap-anywhere', className)}>
      {emailBreakParts(address).map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </span>
  )
}

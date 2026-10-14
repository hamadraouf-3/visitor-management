import { Phone } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../../utils/cn'
import { telHref } from '../../utils/phone'

export interface PhoneNumberProps {
  /** The number as stored, or that text with a part marked (a search match). */
  children: ReactNode
  className?: string
}

/**
 * A phone number laid out left to right in the order it is stored and dialled. Use it
 * wherever a phone number is shown.
 *
 * Arabic-Indic digits are "Arabic numbers" to the Unicode bidirectional algorithm, and a space
 * between two groups of them resolves right to left. Even on this left-to-right page,
 * "+٩٦٢ ٧٩ ٥٠٠ ١٠٠٢" therefore showed its groups in reverse ("+١٠٠٢ ٥٠٠ ٧٩ ٩٦٢"). A
 * `dir="ltr"` isolate alone does not change that, because the page is already left to right.
 * An override does: every character is laid out in stored order, whatever the text around it.
 * The isolation keeps the number from reordering the text around it.
 */
export function PhoneNumber({ children, className }: PhoneNumberProps) {
  return (
    <bdo dir="ltr" className={cn('tabular-nums [unicode-bidi:isolate-override]', className)}>
      {children}
    </bdo>
  )
}

export interface PhoneLinkProps {
  phone: string
  /** Names whom the call reaches, e.g. "Call Omar Khalil"; the number is appended. */
  label?: string
  className?: string
}

/**
 * A tap-to-call phone number (host and visitor contacts, D-26). The number never breaks
 * across lines, so it cannot be misread while dialling (the evacuation list is used to call
 * hosts). On touch screens the tap area is 44 px tall while the line keeps its height (padding
 * offset by a negative margin), so the link lines up with the text around it.
 *
 * The link dials the digits shown, in the order shown (`telHref`). A stored number that cannot
 * be dialled as shown (an older row that does not follow the phone grammar) is plain text.
 */
export function PhoneLink({ phone, label, className }: PhoneLinkProps) {
  const href = telHref(phone)
  if (!href) return <PhoneNumber className={cn('whitespace-nowrap', className)}>{phone}</PhoneNumber>
  return (
    <a
      href={href}
      aria-label={label ? `${label}: ${phone}` : undefined}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-sm font-medium whitespace-nowrap text-accent-text hover:underline pointer-coarse:-my-3 pointer-coarse:py-3',
        className,
      )}
    >
      <Phone aria-hidden="true" className="size-4 shrink-0" />
      <PhoneNumber>{phone}</PhoneNumber>
    </a>
  )
}

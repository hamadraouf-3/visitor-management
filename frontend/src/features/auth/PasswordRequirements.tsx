import { Check, Circle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../utils/cn'
import { passwordRequirements } from '../../utils/passwordPolicy'

interface PasswordRequirementsProps {
  password: string
  /** Known on change-password (enables the "not your email" check); unknown on reset. */
  email?: string
  id?: string
}

/**
 * Password policy hints (§7.1). Rules the browser can check show live status as text and
 * icon (not color alone); the rest are listed as guidance — the server has the final word.
 */
export function PasswordRequirements({ password, email, id }: PasswordRequirementsProps) {
  const { t } = useTranslation('auth')
  const checks = passwordRequirements(password, email).filter((item) => email !== undefined || item.id !== 'not-email')
  const guidance = [...(email === undefined ? [t('password.notYourEmail')] : []), t('password.notCommon')]

  return (
    <div id={id} className="rounded-md border border-border bg-canvas px-3 py-2 text-sm">
      <p className="font-medium text-fg">{t('password.requirementsTitle')}</p>
      <ul className="mt-1 flex flex-col gap-1">
        {checks.map((item) => (
          <li key={item.id} className={cn('flex items-center gap-2', item.met ? 'text-success-text' : 'text-fg-muted')}>
            {item.met ? <Check aria-hidden="true" className="size-4 shrink-0" /> : <Circle aria-hidden="true" className="size-4 shrink-0" />}
            <span>
              {item.label}
              <span className="sr-only">{item.met ? t('password.met') : t('password.notMet')}</span>
            </span>
          </li>
        ))}
      </ul>
      <ul className="mt-1 list-disc ps-6 text-fg-muted">
        {guidance.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </div>
  )
}

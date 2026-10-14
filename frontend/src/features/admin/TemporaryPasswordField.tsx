import { Check, Circle, Eye, EyeOff, WandSparkles } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { FieldMessages } from '../../components/ui/Field'
import { Input } from '../../components/ui/Input'
import { cn } from '../../utils/cn'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordLength } from '../../utils/passwordPolicy'
import { generateTemporaryPassword } from './temporaryPassword'

export interface TemporaryPasswordFieldProps {
  id: string
  value: string
  onChange: (value: string) => void
  /** The new account's email address (the password must differ from it). */
  email: string
  error?: string
}

/**
 * The temporary password of a new account (D-11): typed or generated, with the policy the
 * browser can check shown live (text and icon, not color alone, §7.1). A generated password is
 * shown in clear so it can be passed on; it is shown once more after the account is created.
 */
export function TemporaryPasswordField({ id, value, onChange, email, error }: TemporaryPasswordFieldProps) {
  const { t } = useTranslation(['admin', 'auth', 'common'])
  const [visible, setVisible] = useState(false)
  const length = passwordLength(value)
  const checks = [
    {
      id: 'length',
      label: t('auth:password.requirementLength', { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH }),
      met: length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH,
    },
    {
      id: 'email',
      label: t('users.form.passwordNotEmail'),
      met: value.length > 0 && value.trim().toLowerCase() !== email.trim().toLowerCase(),
    },
  ]
  const hintId = `${id}-hint`
  const errorId = error ? `${id}-error` : undefined

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-fg">
        {t('users.form.temporaryPassword')}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        {/* The password and its show/hide button are one left-to-right control in both languages: the
            input's `pe-12` resolves against the input's own direction and the button's `end-0` against
            this box's, so in Arabic they named opposite sides and the button covered the password's
            first characters (L-23). */}
        <div dir="ltr" className="relative min-w-0 flex-1">
          <Input
            id={id}
            type={visible ? 'text' : 'password'}
            value={value}
            autoComplete="new-password"
            spellCheck={false}
            aria-describedby={[hintId, errorId].filter(Boolean).join(' ')}
            invalid={Boolean(error)}
            onChange={(event) => onChange(event.target.value)}
            dir="ltr"
            className="pe-12 font-mono"
          />
          <button
            type="button"
            onClick={() => setVisible((current) => !current)}
            aria-pressed={visible}
            className="absolute inset-y-0 end-0 flex w-11 items-center justify-center rounded-e-control text-fg-muted hover:text-fg"
          >
            {visible ? <EyeOff aria-hidden="true" className="size-5" /> : <Eye aria-hidden="true" className="size-5" />}
            <span className="sr-only">{t('common:actions.showPassword')}</span>
          </button>
        </div>
        <Button
          variant="secondary"
          icon={<WandSparkles aria-hidden="true" />}
          onClick={() => {
            onChange(generateTemporaryPassword())
            setVisible(true)
          }}
        >
          {t('users.form.generate')}
        </Button>
      </div>
      {/* The password rules: the ones the browser can check show their state (text and icon), the rest is guidance. */}
      <div id={hintId} className="rounded-control border border-border-subtle bg-surface-sunken px-3.5 py-2.5 text-sm">
        <ul className="flex flex-col gap-1">
          {checks.map((check) => (
            <li key={check.id} className={cn('flex items-center gap-2', check.met ? 'text-success-text' : 'text-fg-muted')}>
              {check.met ? <Check aria-hidden="true" className="size-4 shrink-0" /> : <Circle aria-hidden="true" className="size-4 shrink-0" />}
              <span>
                {check.label}
                <span className="sr-only">{check.met ? t('auth:password.met') : t('auth:password.notMet')}</span>
              </span>
            </li>
          ))}
        </ul>
        <ul className="mt-1 list-disc ps-6 text-fg-muted">
          <li>{t('auth:password.notCommon')}</li>
        </ul>
      </div>
      <FieldMessages error={error} errorId={errorId} />
    </div>
  )
}

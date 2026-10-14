import { useEffect, useRef, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { CopyButton } from '../../components/ui/CopyButton'
import { EmailText } from '../../components/ui/EmailText'
import { Field } from '../../components/ui/Field'
import { Input } from '../../components/ui/Input'
import { ReadOnlyField } from '../../components/ui/ReadOnlyField'

export interface TemporaryPasswordRevealProps {
  /** The new administrator: named in the confirmation, their sign-in address shown. */
  fullName: string
  email: string
  /** Shown here once; it lives only in the state of the page or dialog that created the account. */
  temporaryPassword: string
  /**
   * The company is active: its administrators can sign in. An administrator added to a deactivated
   * company cannot until it is reactivated, and the confirmation says so instead of "can now sign
   * in" (UX review M4).
   */
  companyActive: boolean
  /** Focus (and select) the password when shown on a page: what the platform owner came for. */
  focusOnShow?: boolean
  /** The password's control, for a dialog's initial focus (`Dialog initialFocusRef`). */
  passwordRef?: RefObject<HTMLInputElement | null>
}

/**
 * A new administrator's sign-in, shown once (D-11, as for `POST /users`): the confirmation, the
 * e-mail address as text that wraps, and the temporary password read-only with a copy button. The
 * page or dialog around it says the one line (shown once, when it expires).
 */
export function TemporaryPasswordReveal({ fullName, email, temporaryPassword, companyActive, focusOnShow = false, passwordRef: externalRef }: TemporaryPasswordRevealProps) {
  const { t } = useTranslation(['platform', 'admin'])
  const ownRef = useRef<HTMLInputElement>(null)
  const passwordRef = externalRef ?? ownRef
  useEffect(() => {
    if (focusOnShow) passwordRef.current?.focus()
  }, [focusOnShow, passwordRef])

  return (
    <div className="flex flex-col gap-4">
      <Alert
        tone={companyActive ? 'success' : 'info'}
        role="status"
        title={companyActive ? t('created.canSignIn', { name: fullName }) : t('created.canSignInLater', { name: fullName })}
      />
      <ReadOnlyField label={t('form.email')}>
        <EmailText address={email} />
      </ReadOnlyField>
      <div className="flex flex-col gap-2">
        <Field label={t('admin:users.form.temporaryPassword')}>
          <Input ref={passwordRef} readOnly dir="ltr" value={temporaryPassword} className="font-mono" onFocus={(event) => event.target.select()} />
        </Field>
        <CopyButton value={temporaryPassword} label={t('created.copy')} copiedLabel={t('created.copied')} className="self-start" />
      </div>
    </div>
  )
}

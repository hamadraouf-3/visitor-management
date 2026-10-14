import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../utils/cn'
import { Input, type InputProps } from './Input'

/** Password input with a show/hide toggle (helps on touch keyboards). */
export function PasswordInput({ className, ...props }: Omit<InputProps, 'type'>) {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)
  return (
    <div className={cn('relative', className)}>
      <Input {...props} type={visible ? 'text' : 'password'} className="pe-12" />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        aria-pressed={visible}
        className="absolute inset-y-0 end-0 flex w-11 items-center justify-center rounded-e-control text-fg-muted hover:text-fg"
      >
        {visible ? <EyeOff aria-hidden="true" className="size-5" /> : <Eye aria-hidden="true" className="size-5" />}
        <span className="sr-only">{t('actions.showPassword')}</span>
      </button>
    </div>
  )
}

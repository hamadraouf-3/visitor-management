import { CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../utils/cn'
import { toneIconClasses, toneSurfaceClasses } from './tones'

export type AlertTone = 'info' | 'success' | 'warning' | 'danger'

const icons: Record<AlertTone, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
}

export interface AlertProps {
  tone?: AlertTone
  title?: ReactNode
  children?: ReactNode
  /** Rendered below the message (e.g. a retry button). */
  action?: ReactNode
  onDismiss?: () => void
  /**
   * ARIA role. Defaults to `alert` for danger (announced when it appears, e.g. after a
   * failed submit) and none for static information.
   */
  role?: 'alert' | 'status' | 'none'
  /** E.g. for a dialog's `describedBy`, when the alert is the dialog's one consequence sentence. */
  id?: string
  className?: string
}

export function Alert({ tone = 'info', title, children, action, onDismiss, role, id, className }: AlertProps) {
  const { t } = useTranslation()
  const Icon = icons[tone]
  const resolvedRole = role ?? (tone === 'danger' ? 'alert' : 'none')
  return (
    <div
      id={id}
      role={resolvedRole === 'none' ? undefined : resolvedRole}
      data-tone={tone}
      className={cn('flex gap-3 rounded-card border p-4', toneSurfaceClasses[tone], className)}
    >
      <Icon aria-hidden="true" className={cn('mt-0.5 size-5 shrink-0', toneIconClasses[tone])} />
      <div className="min-w-0 flex-1 text-sm leading-relaxed">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={title ? 'mt-1' : undefined}>{children}</div>}
        {action && <div className="mt-3">{action}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="-m-1 flex size-8 shrink-0 items-center justify-center rounded-item hover:bg-current/10 pointer-coarse:-m-2.5 pointer-coarse:size-11"
        >
          <X aria-hidden="true" className="size-4" />
          <span className="sr-only">{t('actions.dismiss')}</span>
        </button>
      )}
    </div>
  )
}

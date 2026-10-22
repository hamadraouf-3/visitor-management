import { CircleAlert, CircleCheck, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '../../utils/cn'
import { buttonClassName } from './buttonStyles'
import { KEEP_INTERACTIVE_ATTRIBUTE } from './modal'
import { ToastContext, type ToastAction, type ToastApi, type ToastOptions, type ToastTone } from './toastContext'
import { toneIconClasses } from './tones'

const DEFAULT_DURATION_MS = 6000

interface ToastItem {
  id: string
  tone: ToastTone
  title: string
  description?: string
  durationMs: number | null
  action?: ToastAction
}

const icons: Record<ToastTone, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
}

let toastSequence = 0

/**
 * Toast notifications. Two live regions exist from the first render (announcements are
 * unreliable for regions inserted together with their content): polite for confirmations,
 * assertive for errors. The container stays interactive while a modal is open.
 *
 * Placement: at the top centre at every width, over the app bar below `lg` and over the middle
 * of the page header from `lg`. The bottom of the screen and its inline-end corner are where the
 * actions are, and a toast there took the tap meant for them for its 6 s: on phones the scan
 * result's full-width Check in bar, the walk-in's sticky action bar and the confirm buttons of
 * bottom-sheet dialogs; on the reception tablet (820 px) and on desktops (1024 to 1440 px) the
 * scan result's Check in, whose action row ends the result panel at the bottom of the inline
 * end (L-21), and the primary buttons of the sticky action bars.
 *
 * The provider sits above the router, so a toast outlives the page that showed it. `reset`
 * scopes toasts to a session: `AuthProvider` calls it whenever the signed-in user changes.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  // Each `reset` starts a new generation with a new API object; an earlier one shows nothing.
  const [generation, setGeneration] = useState(0)
  const currentGeneration = useRef(0)

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const reset = useCallback(() => {
    currentGeneration.current += 1
    setGeneration(currentGeneration.current)
    setToasts([])
  }, [])

  const api = useMemo<ToastApi>(() => {
    const show = (options: ToastOptions) => {
      toastSequence += 1
      const id = `toast-${toastSequence}`
      // Asked for by a callback of an earlier generation (the previous session): not shown.
      if (generation !== currentGeneration.current) return id
      const tone = options.tone ?? 'info'
      const durationMs = options.durationMs !== undefined ? options.durationMs : tone === 'danger' ? null : DEFAULT_DURATION_MS
      setToasts((current) => [...current, { id, tone, title: options.title, description: options.description, durationMs, action: options.action }])
      return id
    }
    return { show, dismiss, reset }
  }, [generation, dismiss, reset])
  const polite = toasts.filter((toast) => toast.tone !== 'danger')
  const assertive = toasts.filter((toast) => toast.tone === 'danger')

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div
          {...{ [KEEP_INTERACTIVE_ATTRIBUTE]: '' }}
          data-toast-region=""
          className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 p-4 pt-[max(1rem,env(safe-area-inset-top))] print:hidden"
        >
          <div role="status" aria-live="polite" className="flex w-full flex-col items-center gap-2">
            {polite.map((toast) => (
              <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
            ))}
          </div>
          <div role="alert" aria-live="assertive" className="flex w-full flex-col items-center gap-2">
            {assertive.map((toast) => (
              <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
            ))}
          </div>
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const { t } = useTranslation()
  const [paused, setPaused] = useState(false)
  const remaining = useRef(toast.durationMs)
  const Icon = icons[toast.tone]

  useEffect(() => {
    if (paused || remaining.current === null) return
    const startedAt = Date.now()
    const timer = window.setTimeout(() => onDismiss(toast.id), remaining.current)
    return () => {
      window.clearTimeout(timer)
      if (remaining.current !== null) remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt))
    }
  }, [paused, onDismiss, toast.id])

  return (
    <div
      className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-card border border-border bg-surface-raised p-4 text-fg shadow-pop"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon aria-hidden="true" className={cn('mt-0.5 size-5 shrink-0', toneIconClasses[toast.tone])} />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold text-fg">{toast.title}</p>
        {toast.description && <p className="mt-0.5 text-fg-muted">{toast.description}</p>}
        {toast.action && (
          <button
            type="button"
            data-toast-action=""
            onClick={() => {
              toast.action?.onAction()
              onDismiss(toast.id)
            }}
            // The kit's small secondary button: 36 px, 44 px on touch screens.
            className={buttonClassName({ variant: 'secondary', size: 'sm', className: 'mt-2.5' })}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="-m-1 flex size-8 shrink-0 items-center justify-center rounded-item text-fg-muted hover:bg-surface-muted hover:text-fg pointer-coarse:-m-2.5 pointer-coarse:size-11"
      >
        <X aria-hidden="true" className="size-4" />
        <span className="sr-only">{t('actions.dismissNotification')}</span>
      </button>
    </div>
  )
}

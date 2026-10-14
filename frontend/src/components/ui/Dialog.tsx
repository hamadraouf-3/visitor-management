import { X } from 'lucide-react'
import { Children, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useStableId } from '../../hooks/useStableId'
import { cn } from '../../utils/cn'
import { MODAL_CLOSE_ATTRIBUTE, MODAL_ROOT_ATTRIBUTE, useModalBehavior } from './modal'

type DialogSize = 'sm' | 'md' | 'lg'

const sizeClasses: Record<DialogSize, string> = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
}

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  /**
   * The id of an element in the body that describes the dialog, when the description is not a
   * line under the title: the one consequence sentence of a confirmation shown as a warning
   * (`<Alert id>`), so a screen reader announces it with the title.
   */
  describedBy?: string
  children?: ReactNode
  /**
   * Action buttons in reading order, the safe choice (e.g. "Keep visit") first and the primary
   * action last: at the end of the row on wide screens (right in English, left in Arabic), and
   * below the safe choice when they stack on phones.
   * Buttons that do not fit one row wrap onto the next instead of leaving the panel; give a
   * dialog with three long labels `size="lg"` so they usually share one row.
   */
  footer?: ReactNode
  size?: DialogSize
  /** Element focused on open; defaults to the first focusable element of the content. */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** `alertdialog` for confirmations of destructive actions. */
  role?: 'dialog' | 'alertdialog'
  /** Backdrop clicks close the dialog unless disabled (e.g. while a mutation runs). */
  dismissible?: boolean
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  describedBy,
  children,
  footer,
  size = 'md',
  initialFocusRef,
  role = 'dialog',
  dismissible = true,
}: DialogProps) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useStableId('dialog-title')
  const descriptionId = useStableId('dialog-description')
  const close = () => {
    if (dismissible) onClose()
  }
  useModalBehavior({ open, onClose: close, panelRef, initialFocusRef })

  if (!open) return null
  // A body only for content that renders (`{error && <Alert/>}` may be false): an empty body would draw a band.
  const hasBody = Children.toArray(children).length > 0

  return createPortal(
    <div {...{ [MODAL_ROOT_ATTRIBUTE]: '' }} className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      {/* Pointer-only affordance; keyboard users close with Escape or the Close button. */}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div aria-hidden="true" className="absolute inset-0 bg-overlay" onClick={close} />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : describedBy}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-[calc(100dvh-2rem)] w-full flex-col rounded-panel bg-surface-raised text-fg shadow-pop focus:outline-none',
          sizeClasses[size],
        )}
      >
        {/* The close button keeps its 44 px target but adds no height (negative block margins): the
            title has the same space above and below, and the button is level with its first line. */}
        <header className="flex items-start justify-between gap-4 border-b border-border-subtle px-6 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg leading-snug font-bold text-fg">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-1 text-sm text-fg-muted">
                {description}
              </p>
            )}
          </div>
          {dismissible && (
            <button
              type="button"
              {...{ [MODAL_CLOSE_ATTRIBUTE]: '' }}
              onClick={onClose}
              data-dialog-close=""
              className="-me-2 -my-2.5 flex size-11 shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-surface-muted hover:text-fg"
            >
              <X aria-hidden="true" className="size-5" />
              <span className="sr-only">{t('actions.close')}</span>
            </button>
          )}
        </header>
        {hasBody && <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 text-sm text-fg">{children}</div>}
        {footer && (
          // Without a body the header's hairline already separates the actions.
          <footer className={cn('flex flex-col gap-2 px-6 py-4 sm:flex-row sm:flex-wrap sm:justify-end', hasBody && 'border-t border-border-subtle')}>
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  )
}

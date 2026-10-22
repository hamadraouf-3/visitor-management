import { X } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useStableId } from '../../hooks/useStableId'
import { cn } from '../../utils/cn'
import { MODAL_CLOSE_ATTRIBUTE, MODAL_ROOT_ATTRIBUTE, useModalBehavior } from './modal'

export interface SheetProps {
  open: boolean
  onClose: () => void
  /** The sheet's heading and accessible name. */
  title: ReactNode
  /** A line of facts under the title (chips, a company). */
  meta?: ReactNode
  /** Actions at the foot, always in view (the body scrolls). */
  footer?: ReactNode
  children: ReactNode
}

/**
 * A modal side panel for one item of a page (Phase 16: a visitor of the live map), the page staying in view
 * beside it: on the inline-end side from `lg` (right in English, left in Arabic), a bottom sheet below it.
 * The same focus, Escape, inert and scroll behaviour as `Dialog`; its body scrolls, its header and footer stay.
 */
export function Sheet({ open, onClose, title, meta, footer, children }: SheetProps) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useStableId('sheet-title')
  // The panel itself takes the focus: its name (the title) is read first, and nothing is pressed by mistake.
  useModalBehavior({ open, onClose, panelRef, initialFocusRef: panelRef })

  if (!open) return null

  return createPortal(
    <div {...{ [MODAL_ROOT_ATTRIBUTE]: '' }} className="fixed inset-0 z-50">
      {/* Pointer-only affordance; keyboard users close with Escape or the Close button. */}
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div aria-hidden="true" className="absolute inset-0 bg-overlay" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-sheet=""
        className={cn(
          'absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col rounded-t-panel bg-surface-raised text-fg shadow-pop focus:outline-none',
          'lg:start-auto lg:top-0 lg:max-h-none lg:w-[28rem] lg:rounded-none',
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
          <div className="flex min-w-0 flex-col gap-2">
            <h2 id={titleId} className="text-lg leading-snug font-bold break-words text-fg">
              {title}
            </h2>
            {meta}
          </div>
          <button
            type="button"
            {...{ [MODAL_CLOSE_ATTRIBUTE]: '' }}
            onClick={onClose}
            data-sheet-close=""
            className="-me-2 -mt-1.5 flex size-11 shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-surface-muted hover:text-fg"
          >
            <X aria-hidden="true" className="size-5" />
            <span className="sr-only">{t('actions.close')}</span>
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm text-fg">{children}</div>
        {footer && <footer className="flex flex-wrap gap-2 border-t border-border-subtle px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

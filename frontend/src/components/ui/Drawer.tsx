import { X } from 'lucide-react'
import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useStableId } from '../../hooks/useStableId'
import { cn } from '../../utils/cn'
import { MODAL_CLOSE_ATTRIBUTE, MODAL_ROOT_ATTRIBUTE, useModalBehavior } from './modal'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  /** Accessible name (also shown as the drawer heading). */
  title: ReactNode
  /** Above the title, e.g. the logo. Decorative or named by itself; not part of the drawer's name. */
  header?: ReactNode
  /** Classes of the panel, e.g. `theme-shell` for the navigation drawer of the teal shell. */
  panelClassName?: string
  /**
   * The panel's background utility, `bg-surface` by default. Pass the one the panel needs instead
   * (`bg-shell` for the shell's drawer): `cn` only joins classes, and two background
   * utilities on one element are decided by the stylesheet's order, not by the order given.
   */
  surfaceClassName?: string
  children: ReactNode
}

/**
 * Modal side panel (mobile/tablet navigation), on the inline-start side: left in English, right
 * in Arabic. Same focus/escape/inert behavior as Dialog.
 */
export function Drawer({ open, onClose, title, header, panelClassName, surfaceClassName = 'bg-surface', children }: DrawerProps) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useStableId('drawer-title')
  useModalBehavior({ open, onClose, panelRef })

  if (!open) return null

  return createPortal(
    <div {...{ [MODAL_ROOT_ATTRIBUTE]: '' }} className="fixed inset-0 z-50">
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div aria-hidden="true" className="absolute inset-0 bg-overlay" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          'absolute inset-y-0 start-0 flex w-80 max-w-[85vw] flex-col text-fg shadow-pop focus:outline-none',
          surfaceClassName,
          panelClassName,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-col gap-3 pt-1.5">
            {header}
            <h2 id={titleId} className="truncate text-base font-semibold text-fg">
              {title}
            </h2>
          </div>
          <button
            type="button"
            {...{ [MODAL_CLOSE_ATTRIBUTE]: '' }}
            onClick={onClose}
            className="flex size-11 shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-surface-muted hover:text-fg"
          >
            <X aria-hidden="true" className="size-5" />
            <span className="sr-only">{t('nav.close')}</span>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

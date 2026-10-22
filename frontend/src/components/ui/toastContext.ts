import { createContext, useContext } from 'react'

export type ToastTone = 'info' | 'success' | 'warning' | 'danger'

export interface ToastOptions {
  tone?: ToastTone
  title: string
  description?: string
  /**
   * Milliseconds before auto-dismiss. Defaults: 6 s; danger toasts stay until dismissed
   * so errors are never missed (WCAG 2.2.1).
   */
  durationMs?: number | null
  /**
   * One action under the text (Phase 16: «عرض» / "View" on a tracking alert), which also dismisses the
   * toast. The toasts live above the router: the caller does the navigation (`useNavigate` where it shows it).
   */
  action?: ToastAction
}

export interface ToastAction {
  label: string
  onAction: () => void
}

export interface ToastApi {
  /** Shows a toast and returns its id. Nothing is shown when this API object is from before the last `reset`. */
  show: (options: ToastOptions) => string
  dismiss: (id: string) => void
  /**
   * Removes every toast, errors included, and makes every API object handed out before this call
   * show nothing: a callback still holding one (a request that settles after the session
   * changed) cannot bring a toast back. Called when the signed-in user changes (`AuthProvider`):
   * toasts name visitors and users, and one user's toasts are never shown to the next.
   */
  reset: () => void
}

export const ToastContext = createContext<ToastApi | null>(null)

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast must be used inside <ToastProvider>')
  return api
}

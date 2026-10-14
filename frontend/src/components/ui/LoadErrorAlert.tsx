import { RotateCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from './Alert'
import { ApiErrorMessage } from './ApiErrorMessage'
import { Button } from './Button'

export interface LoadErrorAlertProps {
  /** What could not be loaded: "The visit history could not be loaded". */
  title: string
  /** The failed request; its message (and a reference for server errors) is shown. */
  error: unknown
  onRetry: () => void
  /** The retry is running: "Try again" shows a spinner and stays focusable. */
  retrying?: boolean
  /** Text after the error message, e.g. what the screen shows meanwhile. */
  children?: ReactNode
  className?: string
}

/**
 * A screen's data could not be loaded: the danger alert every screen uses, with the server's
 * message and "Try again". Announced when it appears (role alert).
 */
export function LoadErrorAlert({ title, error, onRetry, retrying = false, children, className }: LoadErrorAlertProps) {
  const { t } = useTranslation()
  return (
    <Alert
      tone="danger"
      title={title}
      className={className}
      action={
        <Button variant="secondary" icon={<RotateCw aria-hidden="true" />} loading={retrying} onClick={onRetry}>
          {t('actions.tryAgain')}
        </Button>
      }
    >
      <ApiErrorMessage error={error} />
      {children}
    </Alert>
  )
}

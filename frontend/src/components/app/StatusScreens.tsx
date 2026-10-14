import { CloudOff, ShieldX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { getErrorMessage } from '../../api/client'
import { PageSpinner } from '../ui/Spinner'
import { Button, ButtonLink } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'

/** Shown while the session is being resolved on first load ("Loading…" in the UI language by default). */
export function FullPageLoader({ label }: { label?: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas">
      <PageSpinner label={label} />
    </div>
  )
}

/** The session could not be checked (server unreachable); offers a retry. */
export function SessionCheckError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <EmptyState
        icon={CloudOff}
        title={t('app.sessionLoadFailed')}
        description={getErrorMessage(error)}
        action={<Button onClick={onRetry}>{t('actions.tryAgain')}</Button>}
        className="w-full max-w-md"
      />
    </div>
  )
}

/** Rendered inside the app layout when a role guard cannot redirect anywhere better. */
export function AccessDenied({ homePath }: { homePath?: string }) {
  const { t } = useTranslation()
  return (
    <EmptyState
      icon={ShieldX}
      title={t('accessDenied.title')}
      action={homePath ? <ButtonLink to={homePath}>{t('actions.goHome')}</ButtonLink> : undefined}
    />
  )
}

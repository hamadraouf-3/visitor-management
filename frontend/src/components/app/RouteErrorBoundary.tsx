import { RotateCw, TriangleAlert } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { isRouteErrorResponse, useRouteError } from 'react-router'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { CenteredLayout } from '../../layouts/CenteredLayout'
import { NotFoundContent } from '../../pages/NotFoundPage'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'

/** A lazy route chunk failed to load: usually a new deployment replaced the old files. */
function isChunkLoadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
      error.message,
    )
  )
}

function ErrorContent() {
  const { t } = useTranslation()
  const error = useRouteError()
  useDocumentTitle(t('errorPage.title'))

  useEffect(() => {
    console.error('Route error', error)
  }, [error])

  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundContent />

  const chunkError = isChunkLoadError(error)
  return (
    <EmptyState
      icon={TriangleAlert}
      headingLevel="h1"
      title={chunkError ? t('errorPage.newVersionTitle') : t('errorPage.unexpectedTitle')}
      action={
        <Button icon={<RotateCw aria-hidden="true" />} onClick={() => window.location.reload()}>
          {t('actions.reloadPage')}
        </Button>
      }
    />
  )
}

/** Error boundary for routes inside the app layout (navigation stays usable). */
export function PageErrorBoundary() {
  return <ErrorContent />
}

/** Last-resort error boundary for the whole app. */
export function RootErrorBoundary() {
  return (
    <CenteredLayout>
      <ErrorContent />
    </CenteredLayout>
  )
}

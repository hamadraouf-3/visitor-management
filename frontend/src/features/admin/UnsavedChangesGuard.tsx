import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useBlocker } from 'react-router'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'

export interface UnsavedChangesGuardProps {
  dirty: boolean
  /**
   * What would be lost, in the page's own words ("Your changes to the company settings have not
   * been saved."): the dialog once named the company settings on the e-mail texts page (UX review M1).
   */
  description: string
}

/**
 * Asks before leaving the page with unsaved changes (in-app navigation and closing the tab): the
 * company settings and the e-mail texts.
 */
export function UnsavedChangesGuard({ dirty, description }: UnsavedChangesGuardProps) {
  const { t } = useTranslation('admin')
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname)

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Older browsers show the prompt only when a return value is set.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  return (
    <Dialog
      open={blocker.state === 'blocked'}
      role="alertdialog"
      onClose={() => blocker.reset?.()}
      title={t('unsavedChanges.title')}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={() => blocker.reset?.()}>
            {t('unsavedChanges.stay')}
          </Button>
          <Button variant="danger" onClick={() => blocker.proceed?.()}>
            {t('unsavedChanges.leave')}
          </Button>
        </>
      }
    />
  )
}

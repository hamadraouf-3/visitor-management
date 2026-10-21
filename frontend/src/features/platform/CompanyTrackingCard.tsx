import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getErrorMessage } from '../../api/client'
import { Alert } from '../../components/ui/Alert'
import { ApiErrorMessage } from '../../components/ui/ApiErrorMessage'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Dialog } from '../../components/ui/Dialog'
import { Switch } from '../../components/ui/Switch'
import { useToast } from '../../components/ui/toastContext'
import type { PlatformCompany } from '../../types/api'
import { useSetCompanyTracking } from './queries'

export interface CompanyTrackingCardProps {
  company: PlatformCompany
  /** The company's name in the UI language. */
  displayName: string
}

/**
 * «تتبّع الزوار» / "Visitor tracking" of a company (Phase 15): the platform owner's switch, "Tracking
 * allowed". Allowed lets the company's administrator turn it on; it stays off until they do. Stopping it
 * asks first, in one line: it also turns the company's own switch off and ends every running tracking.
 */
export function CompanyTrackingCard({ company, displayName }: CompanyTrackingCardProps) {
  const { t } = useTranslation('platform')
  const toast = useToast()
  const update = useSetCompanyTracking(company.id)
  const [confirmingOff, setConfirmingOff] = useState(false)
  // Cancel, Escape, the close button and the backdrop all leave the same way: the refusal is cleared.
  const closeConfirm = () => {
    setConfirmingOff(false)
    update.reset()
  }

  const apply = (allowed: boolean) =>
    update.mutate(allowed, {
      onSuccess: () => {
        setConfirmingOff(false)
        toast.show({ tone: 'success', title: allowed ? t('company.tracking.allowedToast', { name: displayName }) : t('company.tracking.stoppedToast', { name: displayName }) })
      },
      onError: (error) => {
        if (allowed) toast.show({ tone: 'danger', title: t('company.tracking.failed'), description: getErrorMessage(error) })
      },
    })

  return (
    <Card title={t('company.tracking.title')}>
      <Switch
        label={t('company.tracking.allowed')}
        checked={company.tracking_allowed}
        loading={update.isPending && !confirmingOff}
        onCheckedChange={(next) => (next ? apply(true) : setConfirmingOff(true))}
      />
      <Dialog
        open={confirmingOff}
        role="alertdialog"
        onClose={closeConfirm}
        dismissible={!update.isPending}
        title={t('company.tracking.stopTitle', { name: displayName })}
        description={t('company.tracking.stopDescription')}
        footer={
          <>
            <Button variant="secondary" onClick={closeConfirm} disabled={update.isPending} focusableWhenDisabled>
              {t('company.cancel')}
            </Button>
            <Button variant="danger" loading={update.isPending} onClick={() => apply(false)}>
              {t('company.tracking.stop')}
            </Button>
          </>
        }
      >
        {update.isError ? (
          <Alert tone="danger">
            <ApiErrorMessage error={update.error} />
          </Alert>
        ) : undefined}
      </Dialog>
    </Card>
  )
}

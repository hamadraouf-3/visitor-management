import { Printer, QrCode as QrCodeIcon } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { IdentityLockup } from '../../components/app/IdentityLockup'
import { useLazyQrCode, type QrCodeComponent } from '../../components/qr/useLazyQrCode'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { CopyButton } from '../../components/ui/CopyButton'
import { Dialog } from '../../components/ui/Dialog'
import { Field } from '../../components/ui/Field'
import { Input } from '../../components/ui/Input'
import { PageSpinner } from '../../components/ui/Spinner'
import { useStableId } from '../../hooks/useStableId'
import type { Visit } from '../../types/api'
import { formatVisitDateRange } from './format'
import { passIsOnlyChannel } from './invitationText'

export interface PassActionsProps {
  /** The one-time pass link from POST /visits or POST /visits/{id}/invitation (§6). */
  passUrl: string
  visit: Visit
  companyName: string
  timeZone: string
}

/** The attribute the print stylesheet keys on (src/index.css): only this element is printed. */
export const PRINT_PASS_ATTRIBUTE = 'data-print-pass'

function PrintablePass({ passUrl, visit, companyName, timeZone, QrCode }: PassActionsProps & { QrCode: QrCodeComponent }) {
  const { t } = useTranslation('pass')
  return createPortal(
    // A print-only copy of the pass: hidden on screen (and from assistive technology, which
    // reads the on-screen version), the only thing on paper (see the print rules in index.css).
    // The page's language and direction apply (it is a child of body), so it prints in the UI's.
    <div {...{ [PRINT_PASS_ATTRIBUTE]: '' }} aria-hidden="true" className="hidden bg-white p-8 text-black print:block">
      <div className="mx-auto flex max-w-md flex-col items-center gap-5 rounded-[1.25rem] border-2 border-black p-8 text-center">
        {/* The company's logo (Phase 12), then its name: a company without a logo is its name alone. */}
        <IdentityLockup surface="paper" size="lg" logoOnly />
        <div>
          <p className="text-sm font-semibold tracking-[0.06em] uppercase">{companyName}</p>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
        </div>
        <div>
          <p className="text-xl font-bold">{visit.visitor.full_name}</p>
          {visit.visitor.company_name && <p>{visit.visitor.company_name}</p>}
        </div>
        <div className="w-64">
          <QrCode value={passUrl} label={t('qrLabel')} />
        </div>
        <div>
          <p className="font-numeric text-lg font-semibold">{formatVisitDateRange(visit.scheduled_start, visit.scheduled_end, timeZone)}</p>
          <p className="text-sm">{t('host', { name: visit.host.full_name })}</p>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The one-time pass for the host (§6, §10), as direction C's pass card in the company's colour: the
 * visitor and time, the link with copy, show (a large QR code to show the visitor) and print, and
 * the QR code itself on a white tile at the inline end. The pass link is only in this response and
 * never retrievable later; one short line under the link says so (like the one-time password).
 * When no invitation email reaches the visitor, "Copy link" is the primary action. Used after
 * creating a visit, resending an invitation and issuing a new pass link.
 */
export function PassActions(props: PassActionsProps) {
  const { t } = useTranslation(['visits', 'pass'])
  const { passUrl, visit, timeZone } = props
  const [qrOpen, setQrOpen] = useState(false)
  const headingId = useStableId('pass-actions')
  const qr = useLazyQrCode()
  const onlyChannel = passIsOnlyChannel(visit)
  const when = formatVisitDateRange(visit.scheduled_start, visit.scheduled_end, timeZone)

  return (
    <section aria-labelledby={headingId} className="theme-shell overflow-hidden rounded-card bg-shell text-fg print:hidden">
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex min-w-0 flex-col gap-4 p-5 sm:p-6">
          <div className="min-w-0">
            <h3 id={headingId} className="text-section font-bold">
              {t('pass:title')}
            </h3>
            <p className="mt-1 text-sm break-words">
              <span className="font-semibold">{visit.visitor.full_name}</span>
              <span aria-hidden="true" className="mx-2 inline-block size-1 rounded-full bg-current align-middle" />
              <span className="font-numeric tabular-nums">{when}</span>
            </p>
          </div>
          <Field label={t('passActions.link')} hint={t('passActions.shownOnce')}>
            {/* A web address reads left to right, from its start, in either language. */}
            <Input readOnly dir="ltr" value={passUrl} onFocus={(event) => event.currentTarget.select()} className="font-mono text-sm" />
          </Field>
          <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
            <CopyButton
              value={passUrl}
              label={t('passActions.copy')}
              copiedLabel={t('passActions.copied')}
              variant={onlyChannel ? 'primary' : 'secondary'}
              className="max-sm:items-stretch"
            />
            <Button variant="secondary" icon={<QrCodeIcon aria-hidden="true" />} onClick={() => setQrOpen(true)}>
              {t('passActions.showQr')}
            </Button>
            {/* Enabled once the QR code is on the (print-only) pass, so paper never lacks it. */}
            <Button variant="secondary" icon={<Printer aria-hidden="true" />} disabled={qr.status !== 'ready'} onClick={() => window.print()}>
              {t('pass:print')}
            </Button>
          </div>
          {qr.status === 'error' && <p className="text-sm font-medium">{t('passActions.qrUnavailable')}</p>}
        </div>
        {/* The code itself, black on a white tile as scanners need it, behind a perforation: a picture
            of what "Show QR code" opens large (which names it for assistive technology). */}
        <div
          aria-hidden="true"
          className="flex items-center justify-center border-t-2 border-dashed border-border p-5 sm:border-s-2 sm:border-t-0 sm:p-6"
        >
          <div className="size-40 rounded-control bg-white p-2.5 sm:size-44">
            {qr.status === 'ready' && <qr.QrCode value={passUrl} label={t('pass:qrLabel')} margin={2} />}
          </div>
        </div>
      </div>

      <Dialog
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        title={t('pass:qrLabel')}
        size="sm"
        footer={
          <Button variant="secondary" onClick={() => setQrOpen(false)}>
            {t('detail.newPass.done')}
          </Button>
        }
      >
        {qr.status === 'ready' && (
          <>
            <div className="mx-auto w-full max-w-72">
              <qr.QrCode value={passUrl} label={t('passActions.qrFor', { name: visit.visitor.full_name })} />
            </div>
            <div className="mt-4 text-center">
              <p className="font-semibold text-fg">{visit.visitor.full_name}</p>
              <p className="font-numeric text-sm text-fg-muted tabular-nums">{when}</p>
            </div>
          </>
        )}
        {qr.status === 'loading' && <PageSpinner label={t('passActions.qrPreparing')} />}
        {qr.status === 'error' && <Alert tone="danger">{t('passActions.qrUnavailable')}</Alert>}
      </Dialog>

      {qr.status === 'ready' && <PrintablePass {...props} QrCode={qr.QrCode} />}
    </section>
  )
}

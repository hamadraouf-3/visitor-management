import { useTranslation } from 'react-i18next'
import { getErrorMessage, getErrorReference } from '../../api/client'
import { actionErrorMessage } from '../../utils/forms'

/**
 * The user-facing message of a failed request in the UI language (translated by its error code,
 * F10-6), plus "Reference: <request id>" when the failure is on the server side, so the service
 * desk can find it in the logs. `outsideForm`: no form shows the request's fields, so a 422 says
 * its field messages rather than "Please correct the highlighted fields" (`actionErrorMessage`).
 */
export function ApiErrorMessage({ error, outsideForm = false }: { error: unknown; outsideForm?: boolean }) {
  const { t } = useTranslation('errors')
  const reference = getErrorReference(error)
  return (
    <>
      <span className="block">{outsideForm ? actionErrorMessage(error) : getErrorMessage(error)}</span>
      {reference && (
        <span className="mt-1 block text-xs">
          {t('referenceLabel')}{' '}
          <span dir="ltr" className="font-mono select-all">
            {reference}
          </span>
        </span>
      )}
    </>
  )
}

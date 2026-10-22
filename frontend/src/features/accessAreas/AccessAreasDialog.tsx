import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { hasErrorCode } from '../../api/client'
import { Alert } from '../../components/ui/Alert'
import { ApiErrorMessage } from '../../components/ui/ApiErrorMessage'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { PageSpinner } from '../../components/ui/Spinner'
import { useToast } from '../../components/ui/toastContext'
import { useStableId } from '../../hooks/useStableId'
import type { AccessAreas } from '../journey/types'
import { currentSelection, MAX_AREAS, offeredSelection, sameSelection, selectionOf, toAreasInput, type AreaSelection } from './accessAreas'
import { AccessAreasPicker } from './AccessAreasPicker'
import { useAreaOptions, useUpdateVisitAccessAreas } from './queries'

export interface AccessAreasDialogProps {
  visitId: string
  /** Named in the title: «المناطق المسموحة لـ …». */
  visitorName: string
  /** The visit's areas now: the picker starts from their active places. */
  areas: AccessAreas
  onClose: () => void
}

/**
 * Changing a visit's allowed areas (Phase 16): the picker over the company's active places, saved with
 * `PUT /visits/{id}/access-areas`. The visit's very sets (archived places included) again close the dialog
 * without a request; a visit holding an archived place is saved without it, so its areas can be cleared (F16-42).
 * A refusal (a place archived meanwhile) is said in the dialog with the server's own words; a visit that ended
 * meanwhile (409 VISIT_NOT_EDITABLE, whose general words are about editing a scheduled visit) in this dialog's.
 */
export function AccessAreasDialog({ visitId, visitorName, areas, onClose }: AccessAreasDialogProps) {
  const { t } = useTranslation('journey')
  const toast = useToast()
  const options = useAreaOptions()
  const save = useUpdateVisitAccessAreas(visitId)
  const [chosen, setChosen] = useState<AreaSelection>(() => selectionOf(areas))
  const [tooMany, setTooMany] = useState(false)
  const formId = useStableId('areas-form')
  // Only what the picker offers now is shown and sent: a place archived while the dialog is open drops out.
  const value = options.data ? offeredSelection(chosen, options.data) : chosen

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (value.floorIds.length > MAX_AREAS || value.zoneIds.length > MAX_AREAS) {
      setTooMany(true)
      return
    }
    if (sameSelection(value, currentSelection(areas))) {
      onClose()
      return
    }
    save.mutate(toAreasInput(value), {
      onSuccess: () => {
        toast.show({ tone: 'success', title: t('areas.saved') })
        onClose()
      },
    })
  }

  const change = (next: AreaSelection) => {
    setChosen(next)
    setTooMany(false)
    if (save.isError) save.reset()
  }

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      dismissible={!save.isPending}
      title={t('areas.editTitle', { name: visitorName })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending} focusableWhenDisabled>
            {t('areas.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={save.isPending} disabled={!options.data} focusableWhenDisabled>
            {t('areas.save')}
          </Button>
        </>
      }
    >
      {options.isError ? (
        <LoadErrorAlert title={t('areas.loadError')} error={options.error} retrying={options.isFetching} onRetry={() => void options.refetch()} />
      ) : !options.data ? (
        <PageSpinner label={t('areas.loading')} />
      ) : (
        <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
          {save.isError && (
            <Alert tone="danger">{hasErrorCode(save.error, 'VISIT_NOT_EDITABLE') ? t('areas.notEditable') : <ApiErrorMessage error={save.error} outsideForm />}</Alert>
          )}
          <AccessAreasPicker
            options={options.data}
            value={value}
            onChange={change}
            legendHidden
            error={tooMany ? t('areas.tooMany', { max: MAX_AREAS }) : undefined}
            disabled={save.isPending}
          />
        </form>
      )}
    </Dialog>
  )
}

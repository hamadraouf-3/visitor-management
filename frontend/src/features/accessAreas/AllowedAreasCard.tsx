import { Pencil } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import type { AccessAreas } from '../journey/types'
import { hasFloors } from './accessAreas'
import { AccessAreasDialog } from './AccessAreasDialog'
import { AllowedAreasList } from './AllowedAreasList'
import { useAreaOptions } from './queries'

export interface AllowedAreasCardProps {
  visitId: string
  visitorName: string
  areas: AccessAreas
  /** The server's `can_edit_access_areas`: "Edit" opens the picker. */
  canEdit: boolean
}

/**
 * «المناطق المسموحة» / "Allowed areas" of a visit (Phase 16): the visit's page and its journey. "Edit" when the
 * server allows this person to change them and the company has a floor to allow.
 */
export function AllowedAreasCard({ visitId, visitorName, areas, canEdit }: AllowedAreasCardProps) {
  const { t } = useTranslation('journey')
  const [editing, setEditing] = useState(false)
  const options = useAreaOptions(canEdit)
  const editable = canEdit && options.data !== undefined && hasFloors(options.data)
  return (
    <Card
      title={t('areas.title')}
      actions={
        editable && (
          <Button variant="secondary" size="sm" icon={<Pencil aria-hidden="true" />} onClick={() => setEditing(true)} aria-label={t('areas.editNamed')}>
            {t('areas.edit')}
          </Button>
        )
      }
    >
      <div data-allowed-areas-card="">
        <AllowedAreasList areas={areas} />
      </div>
      {editing && <AccessAreasDialog visitId={visitId} visitorName={visitorName} areas={areas} onClose={() => setEditing(false)} />}
    </Card>
  )
}

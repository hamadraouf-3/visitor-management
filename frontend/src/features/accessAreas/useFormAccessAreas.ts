import { useActiveDepartments } from '../../api/queries'
import type { Me } from '../../types/api'
import { departmentSelection, EMPTY_SELECTION, hasFloors, offeredSelection, type AreaOptions, type AreaSelection } from './accessAreas'
import { useAreaOptions } from './queries'

export interface FormAccessAreas {
  /** The field is shown: the company's tracking is allowed and it has an active floor to allow. */
  shown: boolean
  options: AreaOptions | undefined
  /**
   * What the field shows, and what is sent: the person's choice, else the department's floor (followed when the
   * department changes); only the places still offered (one archived since it was chosen is dropped, F16-43).
   */
  value: AreaSelection
}

/**
 * The allowed areas of a new visit (Phase 16), as the invitation and the walk-in forms show them: only while the
 * company's tracking is allowed and it has active floors (nothing is asked for otherwise); prefilled from the
 * chosen department's floor until the person changes the field (`chosen` null), and again whenever the
 * department changes until then.
 */
export function useFormAccessAreas(me: Me | null, departmentId: string, chosen: AreaSelection | null): FormAccessAreas {
  const allowed = me?.company.tracking_allowed ?? false
  const options = useAreaOptions(allowed)
  const departments = useActiveDepartments()
  const shown = allowed && options.data !== undefined && hasFloors(options.data)
  const department = departmentId ? departments.data?.find((candidate) => candidate.id === departmentId) : undefined
  const value = options.data ? offeredSelection(chosen ?? departmentSelection(department, options.data), options.data) : (chosen ?? EMPTY_SELECTION)
  return { shown, options: options.data, value }
}

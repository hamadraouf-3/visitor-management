import { i18n, type Language } from '../../i18n'
import type { Department } from '../../types/api'
import type { AreaOptions } from '../accessAreas/accessAreas'
import { locationName } from '../journey/locationNames'

/*
 * A department's floor (Phase 16): the floor a new visit of the department is allowed on, chosen in the
 * departments list. The choices are the company's active floors; a department's floor that is archived (or
 * not offered for another reason) stays its current choice, marked, until another is chosen.
 */

const t = i18n.getFixedT(null, 'admin')

export type DepartmentFloor = NonNullable<Department['floor']>

export interface FloorChoice {
  id: string
  label: string
}

export interface FloorChoiceGroup {
  /** The building's name, as the group's label, when the company has several; null with one. */
  label: string | null
  floors: FloorChoice[]
}

export interface DepartmentFloorChoices {
  groups: FloorChoiceGroup[]
  /** The department's current floor when it is not among the active ones, "Floor 9 (archived)". */
  current: FloorChoice | null
}

/** The active floors by building (in the server's order, each by level), and the current floor when not among them. */
export function departmentFloorChoices(options: AreaOptions | undefined, floor: Department['floor'], language: Language): DepartmentFloorChoices {
  const buildings = options?.buildings ?? []
  const several = buildings.length > 1
  const groups = buildings.map((group) => ({
    label: several ? locationName(group.building, language) : null,
    floors: group.floors.map((option) => ({ id: option.id, label: locationName(option, language) })),
  }))
  if (!floor || groups.some((group) => group.floors.some((choice) => choice.id === floor.id))) return { groups, current: null }
  const name = several ? `${locationName(floor.building, language)} › ${locationName(floor, language)}` : locationName(floor, language)
  // While the places load, the current floor is shown as it is; once loaded and not offered, it is marked.
  const label = options !== undefined || !floor.is_active ? t('departments.floorArchived', { lng: language, name }) : name
  return { groups, current: { id: floor.id, label } }
}

import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import { areaOptions } from '../accessAreas/accessAreas'
import { FLOOR_3, makeLocationTree, makeTower, TOWER } from '../journey/testRoutes'
import { departmentFloorChoices } from './departmentFloor'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('a department’s floor choices (Phase 16)', () => {
  const options = areaOptions(makeLocationTree())

  it('offers the active floors by level, without a group for one building', () => {
    const choices = departmentFloorChoices(options, null, 'en')
    expect(choices.current).toBeNull()
    expect(choices.groups).toEqual([{ label: null, floors: [expect.objectContaining({ label: 'Ground floor' }), expect.objectContaining({ label: 'Floor 3' }), expect.objectContaining({ label: 'Floor 4' })] }])
    // The Arabic UI names a floor by its Arabic name.
    expect(departmentFloorChoices(options, null, 'ar').groups[0]!.floors.map((floor) => floor.label)).toEqual(['الطابق الأرضي', 'الطابق الثالث', 'الطابق الرابع'])
  })

  it('keeps an offered floor as one of the choices, and marks one that is not', () => {
    expect(departmentFloorChoices(options, { ...FLOOR_3, building: TOWER, is_active: true }, 'en').current).toBeNull()
    const archived = { id: 'f9', name: 'Floor 9', name_ar: 'الطابق التاسع', level: 9, building: TOWER, is_active: false }
    expect(departmentFloorChoices(options, archived, 'en').current).toEqual({ id: 'f9', label: 'Floor 9 (archived)' })
    expect(departmentFloorChoices(options, archived, 'ar').current).toEqual({ id: 'f9', label: 'الطابق التاسع (مؤرشف)' })
    // While the places load, an active floor is shown as it is.
    expect(departmentFloorChoices(undefined, { ...FLOOR_3, building: TOWER, is_active: true }, 'en')).toEqual({ groups: [], current: { id: FLOOR_3.id, label: 'Floor 3' } })
  })

  it('groups the floors by building when there are several, and names the building of a floor not offered', () => {
    const annex = { ...makeTower(), id: 'b2', name: 'Annex', name_ar: null }
    const several = areaOptions(makeLocationTree([annex, makeTower()]))
    const choices = departmentFloorChoices(several, { id: 'f9', name: 'Floor 9', name_ar: null, level: 9, building: TOWER, is_active: false }, 'en')
    expect(choices.groups.map((group) => group.label)).toEqual(['Annex', 'North Tower'])
    expect(choices.current).toEqual({ id: 'f9', label: 'North Tower › Floor 9 (archived)' })
  })
})

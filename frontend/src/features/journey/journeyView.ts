/**
 * /journey's two views (Phase 16): «الخريطة الحية» / "Live map" (the default) and «القائمة» / "List" (the
 * day's visits, Phase 15), in the address as `?view=list`, so a list's link and its back link keep it.
 */
export const JOURNEY_VIEWS = ['map', 'list'] as const
export type JourneyView = (typeof JOURNEY_VIEWS)[number]

export const VIEW_PARAM = 'view'

/** The tabs' and panels' id base. */
export const JOURNEY_VIEW_TABS = 'journey-view'

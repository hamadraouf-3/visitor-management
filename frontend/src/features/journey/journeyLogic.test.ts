import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import type { EnrollBlocker, JourneyState, Role, TrackingStatus } from '../../types/api'
import { agoSeconds } from './freshness'
import { activeJourneyFilterCount, journeyFilterChanges, journeyListParams, readJourneyFilters } from './journeyFilters'
import { enrollBlockerLabel, isJourneyState, isTracking, JOURNEY_STATE_META, JOURNEY_STATES } from './journeyStates'
import { locationName, otherLocationName } from './locationNames'
import { makeCamera, makeTrackingStatus, makeVisitJourney } from './testRoutes'
import { trackingActionsFor } from './trackingActions'
import { isTrackingOn, trackingBanner } from './trackingStatus'

const ALL_STATES: JourneyState[] = ['DISABLED', 'NOT_ENROLLED', 'PENDING', 'ACTIVE', 'UNCERTAIN', 'STALE', 'UNAVAILABLE', 'ENDED']

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('the journey states', () => {
  it('maps every state of the contract to a chip: words, tone and symbol', () => {
    expect(Object.keys(JOURNEY_STATE_META).toSorted()).toEqual([...ALL_STATES].toSorted())
    expect(Object.fromEntries(ALL_STATES.map((state) => [state, [JOURNEY_STATE_META[state].label, JOURNEY_STATE_META[state].tone]]))).toEqual({
      DISABLED: ['Off', 'neutral'],
      NOT_ENROLLED: ['Not started', 'neutral'],
      PENDING: ['Starting', 'info'],
      ACTIVE: ['Active', 'success'],
      UNCERTAIN: ['Uncertain', 'warning'],
      STALE: ['Not recent', 'warning'],
      UNAVAILABLE: ['Not connected', 'danger'],
      ENDED: ['Ended', 'neutral'],
    })
    // Never colour alone: each state has its own symbol, so two states of one tone still differ.
    expect(new Set(ALL_STATES.map((state) => JOURNEY_STATE_META[state].icon)).size).toBe(ALL_STATES.length)
  })

  it('names the states in Arabic, read when shown', async () => {
    await i18n.changeLanguage('ar')
    expect(ALL_STATES.map((state) => JOURNEY_STATE_META[state].label)).toEqual(['غير مفعّل', 'لم يبدأ', 'قيد البدء', 'نشط', 'غير مؤكد', 'قديم', 'غير متصل', 'انتهى'])
  })

  it('offers every state in the filter once, the tracked ones first', () => {
    expect([...JOURNEY_STATES].toSorted()).toEqual([...ALL_STATES].toSorted())
    expect(JOURNEY_STATES.slice(0, 4)).toEqual(['ACTIVE', 'UNCERTAIN', 'STALE', 'UNAVAILABLE'])
    expect(isJourneyState('ACTIVE')).toBe(true)
    expect(isJourneyState('active')).toBe(false)
    expect(isJourneyState(null)).toBe(false)
  })

  it('says which states have a running association', () => {
    expect(ALL_STATES.filter(isTracking)).toEqual(['PENDING', 'ACTIVE', 'UNCERTAIN', 'STALE', 'UNAVAILABLE'])
  })

  it('words every enrolment blocker as a short state, except the two that show no disabled button', () => {
    const blockers: EnrollBlocker[] = ['NOT_PERMITTED', 'PROVIDER_DISABLED', 'NOT_ALLOWED', 'NOT_ENABLED', 'ALREADY_ENROLLED', 'NOT_CHECKED_IN', 'NO_ENROLLMENT_POINT']
    expect(Object.fromEntries(blockers.map((blocker) => [blocker, enrollBlockerLabel(blocker)]))).toEqual({
      PROVIDER_DISABLED: 'No tracking provider',
      NOT_ALLOWED: 'Tracking not allowed',
      NOT_ENABLED: 'Tracking is off',
      NOT_CHECKED_IN: 'Not inside',
      ALREADY_ENROLLED: null,
      NO_ENROLLMENT_POINT: 'No reception camera',
      NOT_PERMITTED: null,
    })
  })
})

const status = (overrides: Partial<TrackingStatus>) => makeTrackingStatus({ provider: 'disabled', simulated: false, ...overrides })

describe('the tracking banner', () => {

  it('says "No tracking provider" when the deployment has none, whatever the company’s switches', () => {
    expect(trackingBanner(status({ available: false, healthy: false }))).toEqual({ line: 'noProvider', simulated: false })
    expect(trackingBanner(status({ available: false, allowed: false, enabled: false, healthy: false }))).toEqual({ line: 'noProvider', simulated: false })
  })

  it('says "Tracking is off" while not allowed, and while not enabled', () => {
    expect(trackingBanner(makeTrackingStatus({ allowed: false, healthy: false }))).toEqual({ line: 'off', simulated: true })
    expect(trackingBanner(makeTrackingStatus({ enabled: false, healthy: false }))).toEqual({ line: 'off', simulated: true })
  })

  it('says the provider is not connected when tracking is on but the provider is not healthy', () => {
    expect(trackingBanner(makeTrackingStatus({ healthy: false }))).toEqual({ line: 'notConnected', simulated: true })
  })

  it('says only "Simulated" when the simulator is on and healthy, and nothing for a healthy real provider', () => {
    expect(trackingBanner(makeTrackingStatus())).toEqual({ line: null, simulated: true })
    // A provider other than the simulator (none exists yet): nothing to say.
    expect(trackingBanner({ ...makeTrackingStatus(), simulated: false, provider: 'disabled', available: true })).toEqual({ line: null, simulated: false })
  })

  it('knows when tracking is on', () => {
    expect(isTrackingOn(undefined)).toBe(false)
    expect(isTrackingOn(makeTrackingStatus())).toBe(true)
    expect(isTrackingOn(makeTrackingStatus({ enabled: false }))).toBe(false)
  })
})

describe('what the journey page offers', () => {
  const reception: Role[] = ['RECEPTIONIST']
  const camera = makeCamera()

  it('offers a stop while the association runs, to reception and administrators', () => {
    const journey = makeVisitJourney()
    expect(trackingActionsFor(journey, [camera], reception)).toEqual({ kind: 'stop' })
    expect(trackingActionsFor(journey, [camera], ['SYSTEM_ADMIN'])).toEqual({ kind: 'stop' })
  })

  it('offers nothing to management, whatever the server says', () => {
    const journey = makeVisitJourney({ can_revoke: false, can_enroll: false, enroll_blocker: 'NOT_ENABLED' })
    expect(trackingActionsFor(journey, [camera], ['MANAGEMENT'])).toEqual({ kind: 'none' })
    expect(trackingActionsFor(makeVisitJourney(), [camera], ['MANAGEMENT', 'EMPLOYEE'])).toEqual({ kind: 'none' })
  })

  it('offers a start at the reception cameras once they are known, when the server says it can be made', () => {
    const journey = makeVisitJourney({ state: 'NOT_ENROLLED', association: null, can_enroll: true, enroll_blocker: null, can_revoke: false })
    expect(trackingActionsFor(journey, null, reception)).toEqual({ kind: 'none' })
    expect(trackingActionsFor(journey, [camera], reception)).toEqual({ kind: 'start', cameras: [camera] })
    expect(trackingActionsFor(journey, [], reception)).toEqual({ kind: 'blocked', blocker: 'NO_ENROLLMENT_POINT' })
  })

  it('shows the server’s reason beside a disabled start', () => {
    for (const blocker of ['PROVIDER_DISABLED', 'NOT_ALLOWED', 'NOT_ENABLED', 'NOT_CHECKED_IN', 'NO_ENROLLMENT_POINT'] as const) {
      const journey = makeVisitJourney({ state: 'NOT_ENROLLED', association: null, can_enroll: false, enroll_blocker: blocker, can_revoke: false })
      expect(trackingActionsFor(journey, [camera], reception)).toEqual({ kind: 'blocked', blocker })
    }
    const permitted = makeVisitJourney({ can_enroll: false, enroll_blocker: 'NOT_PERMITTED', can_revoke: false })
    expect(trackingActionsFor(permitted, [camera], reception)).toEqual({ kind: 'none' })
  })
})

describe('the list’s filters', () => {
  const today = '2026-10-20'

  it('reads the day, the state and the search from the address, ignoring what is malformed', () => {
    expect(readJourneyFilters(new URLSearchParams('day=2026-10-18&state=STALE&q=%20Maya%20'))).toEqual({ date: '2026-10-18', state: 'STALE', q: 'Maya' })
    expect(readJourneyFilters(new URLSearchParams('day=2026-13-40&state=SOMEWHERE'))).toEqual({ date: null, state: null, q: '' })
  })

  it('writes today as no day, and goes back to the first page on any change', () => {
    expect(journeyFilterChanges({ date: today }, today)).toEqual({ page: null, day: null })
    expect(journeyFilterChanges({ date: '2026-10-19', state: 'ACTIVE', q: '  cedar ' }, today)).toEqual({ page: null, day: '2026-10-19', state: 'ACTIVE', q: 'cedar' })
    expect(activeJourneyFilterCount({ date: today, state: null, q: '' }, today)).toBe(0)
    expect(activeJourneyFilterCount({ date: '2026-10-19', state: 'ACTIVE', q: 'x' }, today)).toBe(3)
  })

  it('asks the API for the day, the state (as a list) and the search', () => {
    expect(journeyListParams({ date: null, state: null, q: '' }, 1)).toEqual({ page: 1, page_size: 25 })
    expect(journeyListParams({ date: '2026-10-19', state: 'UNCERTAIN', q: 'Maya' }, 2)).toEqual({ page: 2, page_size: 25, day: '2026-10-19', state: ['UNCERTAIN'], q: 'Maya' })
  })
})

describe('a place’s name', () => {
  it('is the Arabic name in Arabic when it has one, else its name', () => {
    expect(locationName({ name: 'Lobby', name_ar: 'الردهة' }, 'ar')).toBe('الردهة')
    expect(locationName({ name: 'Lobby', name_ar: 'الردهة' }, 'en')).toBe('Lobby')
    expect(locationName({ name: 'Lobby', name_ar: '  ' }, 'ar')).toBe('Lobby')
    expect(otherLocationName({ name: 'Lobby', name_ar: 'الردهة' }, 'en')).toBe('الردهة')
    expect(otherLocationName({ name: 'Lobby', name_ar: null }, 'en')).toBeNull()
  })
})

describe('how long ago', () => {
  it('counts on from when the server answered, and never from an unknown time', () => {
    const answeredAt = Date.parse('2026-10-20T09:00:00Z')
    expect(agoSeconds(240, answeredAt, answeredAt + 60_000)).toBe(300)
    expect(agoSeconds(240, answeredAt, answeredAt - 5_000)).toBe(240)
    // A query reports 0 while it shows placeholder rows: the server's own figure, not decades.
    expect(agoSeconds(240, 0, answeredAt)).toBe(240)
    expect(agoSeconds(null, 0, answeredAt)).toBe(0)
  })
})

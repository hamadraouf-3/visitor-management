import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { routes } from '../../../test/appRoutes'
import { errorResponse, jsonResponse, mockApi, type RecordedRequest, type RouteHandler } from '../../../test/api'
import { renderRoutes } from '../../../test/render'
import type { LocationTree, TrackingCamera, TrackingKey, TrackingSettings } from '../../../types/api'
import { alertSummaryRoute, FLOOR_3, LOBBY, makeCamera, makeTrackedMe, makeTrackingSettings, TOWER } from '../../journey/testRoutes'

const KEY: TrackingKey = {
  id: 'k1000000-0000-4000-8000-000000000001',
  label: 'Shaheen pilot',
  prefix: 'vtk_Ab3d',
  created_at: '2026-10-19T08:00:00Z',
  created_by: { id: 'u1', full_name: 'Amal Haddad' },
  last_used_at: null,
  revoked_at: null,
}

const TREE: LocationTree = {
  buildings: [
    {
      ...TOWER,
      is_active: true,
      created_at: '2026-10-19T08:00:00Z',
      updated_at: '2026-10-19T08:00:00Z',
      floors: [
        {
          ...FLOOR_3,
          building_id: TOWER.id,
          is_active: true,
          created_at: '2026-10-19T08:00:00Z',
          updated_at: '2026-10-19T08:00:00Z',
          zones: [{ ...LOBBY, floor_id: FLOOR_3.id, is_active: true, created_at: '2026-10-19T08:00:00Z', updated_at: '2026-10-19T08:00:00Z' }],
        },
      ],
    },
  ],
}

interface Setup {
  settings?: TrackingSettings
  keys?: TrackingKey[]
  tree?: LocationTree
  cameras?: TrackingCamera[]
  extra?: Record<string, RouteHandler>
  path?: string
}

function setup({ settings = makeTrackingSettings(), keys = [KEY], tree = TREE, cameras = [makeCamera()], extra = {}, path = '/admin/tracking' }: Setup = {}) {
  const state = { settings }
  const api = mockApi({
    'GET /auth/me': () => jsonResponse(makeTrackedMe(['SYSTEM_ADMIN'])),
    'GET /tracking/settings': () => jsonResponse(state.settings),
    'PATCH /tracking/settings': (request) => {
      state.settings = { ...state.settings, ...(request.body as Partial<TrackingSettings>) }
      return jsonResponse(state.settings)
    },
    'GET /tracking/keys': () => jsonResponse(keys),
    'GET /locations': () => jsonResponse(tree),
    'GET /tracking/cameras': () => jsonResponse(cameras),
    // The shell's alert watcher (Phase 16) polls the summary on every page of a tracked company's staff.
    ...alertSummaryRoute(),
    ...extra,
  })
  return { ...api, ...renderRoutes(routes, { initialEntries: [path] }) }
}

const sent = (requests: RecordedRequest[], method: string, path: string) => requests.filter((request) => request.method === method && request.path === path).map((request) => request.body)

describe('Visitor tracking (administration): settings', () => {
  it('turns tracking on at once, and off after one line', async () => {
    const { requests, user } = setup({ settings: makeTrackingSettings({ enabled: false }) })

    const toggle = await screen.findByRole('switch', { name: 'Visitor tracking' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    await user.click(toggle)
    await waitFor(() => expect(sent(requests, 'PATCH', '/tracking/settings')).toEqual([{ enabled: true }]))
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))

    await user.click(toggle)
    const dialog = await screen.findByRole('alertdialog', { name: 'Turn tracking off?' })
    expect(dialog).toHaveTextContent('Every visitor being tracked now stops being tracked.')
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }))
    await waitFor(() => expect(sent(requests, 'PATCH', '/tracking/settings')).toEqual([{ enabled: true }, { enabled: false }]))
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
  })

  it('clears a refused turn-off when the confirmation is cancelled, as Escape does', async () => {
    const { user } = setup({ extra: { 'PATCH /tracking/settings': () => errorResponse(503, 'SERVICE_UNAVAILABLE', 'The service is busy.') } })
    const toggle = await screen.findByRole('switch', { name: 'Visitor tracking' })

    await user.click(toggle)
    let dialog = await screen.findByRole('alertdialog', { name: 'Turn tracking off?' })
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The service is busy.')
    await user.click(within(dialog).getByRole('button', { name: 'Keep it on' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    await user.click(toggle)
    dialog = await screen.findByRole('alertdialog', { name: 'Turn tracking off?' })
    expect(within(dialog).queryByRole('alert')).toBeNull()
  })

  it('cannot be turned on while the platform owner has not allowed it, and says so beside the switch', async () => {
    const { requests, user } = setup({ settings: makeTrackingSettings({ allowed: false, enabled: false }) })
    const toggle = await screen.findByRole('switch', { name: 'Visitor tracking' })
    expect(toggle).toHaveAttribute('aria-disabled', 'true')
    expect(toggle).toHaveAccessibleDescription('Not allowed')
    await user.click(toggle)
    expect(sent(requests, 'PATCH', '/tracking/settings')).toEqual([])
  })

  it('names the provider: the simulator with its Simulated mark, or none', async () => {
    setup()
    const card = (await screen.findByRole('heading', { name: 'Tracking' })).closest('section')!
    expect(card).toHaveTextContent('ProviderSimulator')
    expect(card.querySelector('[data-simulated]')).toHaveTextContent('Simulated')
  })

  it('saves the thresholds that changed, the confidence as a share', async () => {
    const { requests, user } = setup()
    const confidence = await screen.findByRole('textbox', { name: /Minimum confidence/ })
    expect(confidence).toHaveValue('80')
    await user.clear(confidence)
    await user.type(confidence, '87.5')
    expect(screen.getByText('You have unsaved changes.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(sent(requests, 'PATCH', '/tracking/settings')).toEqual([{ min_confidence: 0.875 }]))
    expect(await screen.findByText('Tracking settings saved')).toBeInTheDocument()
  })

  it('refuses a threshold out of its bounds at its field', async () => {
    const { requests, user } = setup()
    const stale = await screen.findByRole('textbox', { name: 'Not recent after' })
    await user.clear(stale)
    await user.type(stale, '300')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Enter a whole number from 1 to 240.')).toBeInTheDocument()
    expect(sent(requests, 'PATCH', '/tracking/settings')).toEqual([])
  })

  it('reads each unit with its field, and refuses a share typed below 1 %', async () => {
    const { requests, user } = setup()
    // The percentage is in the label; the minutes and days describe their fields.
    const confidence = await screen.findByRole('textbox', { name: /^Minimum confidence \(%\)/ })
    expect(screen.getByRole('textbox', { name: 'Not recent after' })).toHaveAccessibleDescription('min')
    expect(screen.getByRole('textbox', { name: 'Keep journeys for' })).toHaveAccessibleDescription('days')

    await user.clear(confidence)
    await user.type(confidence, '0.8')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Enter a percentage from 1 to 100.')).toBeInTheDocument()
    expect(confidence).toHaveAccessibleDescription('Enter a percentage from 1 to 100.')
    expect(sent(requests, 'PATCH', '/tracking/settings')).toEqual([])
  })

  it('shows the provider’s health: contact, refusals by reason, failures', async () => {
    setup({
      settings: makeTrackingSettings({
        health: {
          last_contact_at: null,
          last_accepted_event_at: null,
          rejected_last_24h: [
            { reason: 'UNKNOWN_CAMERA', count: 3 },
            { reason: 'NOT_ACTIVE', count: 2 },
          ],
          provider_errors_last_24h: [],
        },
      }),
    })
    const card = (await screen.findByRole('heading', { name: 'Provider health' })).closest('section')!
    expect(card).toHaveTextContent('Last contactNever')
    expect(card).toHaveTextContent('Unknown camera3')
    expect(card).toHaveTextContent('Not started yet2')
    expect(card).toHaveTextContent('Provider errors in 24 hoursNone')
  })
})

describe('Visitor tracking (administration): keys', () => {
  it('creates a key and shows it once, with a copy button; closing the dialog takes it away', async () => {
    const created = { ...KEY, id: 'k2', label: 'Rotation', prefix: 'vtk_Zz9q', secret: 'vtk_Zz9qsecretsecretsecretsecretsecretsecret1' }
    const { requests, user, queryClient } = setup({ extra: { 'POST /tracking/keys': () => jsonResponse(created, 201) } })

    await screen.findByRole('list', { name: 'Provider keys' })
    await user.click(screen.getByRole('button', { name: 'Create key' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create key' })
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    expect(await within(dialog).findByText('Enter a label.')).toBeInTheDocument()
    await user.type(within(dialog).getByRole('textbox', { name: /Label/ }), 'Rotation')
    await user.click(within(dialog).getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(sent(requests, 'POST', '/tracking/keys')).toEqual([{ label: 'Rotation' }]))

    const shown = await screen.findByRole('dialog', { name: 'Key “Rotation” created' })
    expect(shown).toHaveAccessibleDescription('The key is shown only once.')
    const field = within(shown).getByRole('textbox', { name: 'Key' })
    expect(field).toHaveValue(created.secret)
    expect(field).toHaveAttribute('readonly')
    expect(field).toHaveFocus()
    expect(within(shown).getByRole('button', { name: 'Copy key' })).toBeInTheDocument()
    await user.click(within(shown).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.body).not.toHaveTextContent(created.secret)
    // Nor does the mutation cache keep it once the dialog is gone (`gcTime: 0`).
    await waitFor(() => expect(JSON.stringify(queryClient.getMutationCache().getAll().map((mutation) => mutation.state.data))).not.toContain(created.secret))
  })

  it('waits at two keys in use, with the reason beside the button', async () => {
    setup({ keys: [KEY, { ...KEY, id: 'k2', label: 'Rotation' }, { ...KEY, id: 'k3', label: 'Old', revoked_at: '2026-10-19T09:00:00Z' }] })
    await screen.findByRole('list', { name: 'Provider keys' })
    const create = screen.getByRole('button', { name: 'Create key' })
    expect(create).toHaveAttribute('aria-disabled', 'true')
    expect(create).toHaveAccessibleDescription('Two keys in use')
    const list = screen.getByRole('list', { name: 'Provider keys' })
    expect(within(list).getAllByRole('listitem')[2]).toHaveTextContent('Revoked')
    expect(within(list).getAllByRole('button', { name: /^Revoke / })).toHaveLength(2)
  })

  it('revokes a key after one line, the focus going on to the next key in use', async () => {
    const rotation = { ...KEY, id: 'k2', label: 'Rotation' }
    let keys = [KEY, rotation]
    const { requests, user } = setup({
      extra: {
        'GET /tracking/keys': () => jsonResponse(keys),
        [`DELETE /tracking/keys/${KEY.id}`]: () => {
          keys = [{ ...KEY, revoked_at: '2026-10-20T09:00:00Z' }, rotation]
          return jsonResponse(keys[0])
        },
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Revoke Shaheen pilot' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke the key “Shaheen pilot”?' })
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(requests.some((request) => request.method === 'DELETE' && request.path === `/tracking/keys/${KEY.id}`)).toBe(true))
    expect(await screen.findByText('Key “Shaheen pilot” revoked')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Revoke Shaheen pilot' })).toBeNull())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revoke Rotation' })).toHaveFocus())
  })
})

describe('Visitor tracking (administration): locations', () => {
  it('shows the buildings, their floors by level and each floor’s zones', async () => {
    setup({ path: '/admin/tracking?tab=locations' })
    const floors = await screen.findByRole('list', { name: 'Floors of North Tower' })
    expect(floors).toHaveTextContent('Floor 3')
    expect(within(floors).getByRole('list', { name: 'Zones of Floor 3' })).toHaveTextContent('Lobby')
    // The other language's name, muted under it.
    expect(floors).toHaveTextContent('الطابق الثالث')
  })

  it('adds a building, a floor with its level, and a zone', async () => {
    const { requests, user } = setup({
      path: '/admin/tracking?tab=locations',
      tree: { buildings: [] },
      extra: { 'POST /locations/buildings': (request) => jsonResponse({ id: 'b9', ...(request.body as object), is_active: true, created_at: '', updated_at: '' }, 201) },
    })
    await user.click(await screen.findAllByRole('button', { name: 'Add building' }).then((buttons) => buttons[0]!))
    const dialog = await screen.findByRole('dialog', { name: 'Add building' })
    await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Annex')
    await user.type(within(dialog).getByRole('textbox', { name: /Arabic name/ }), 'الملحق')
    await user.click(within(dialog).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(sent(requests, 'POST', '/locations/buildings')).toEqual([{ name: 'Annex', name_ar: 'الملحق' }]))
  })

  it('adds a floor with its level, and refuses a level the building has', async () => {
    const { requests, user } = setup({
      path: '/admin/tracking?tab=locations',
      extra: { 'POST /locations/floors': (request) => jsonResponse({ id: 'f9', ...(request.body as object), is_active: true, created_at: '', updated_at: '' }, 201) },
    })
    await user.click(await screen.findByRole('button', { name: 'Actions for North Tower' }))
    await user.click(screen.getByRole('menuitem', { name: 'Add floor' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add a floor to North Tower' })
    await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Roof')
    await user.type(within(dialog).getByRole('textbox', { name: /Level/ }), '3')
    await user.click(within(dialog).getByRole('button', { name: 'Add' }))
    expect(await within(dialog).findByText('This building already has a floor at this level.')).toBeInTheDocument()
    await user.clear(within(dialog).getByRole('textbox', { name: /Level/ }))
    await user.type(within(dialog).getByRole('textbox', { name: /Level/ }), '-1')
    await user.click(within(dialog).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(sent(requests, 'POST', '/locations/floors')).toEqual([{ building_id: TOWER.id, name: 'Roof', name_ar: null, level: -1 }]))
  })

  it('archives a place, the focus going on to the next place’s menu', async () => {
    const meeting = { ...LOBBY, id: 'z2', name: 'Meeting rooms', name_ar: null, floor_id: FLOOR_3.id, is_active: true, created_at: '', updated_at: '' }
    const withZones = (lobbyActive: boolean): LocationTree => ({
      buildings: [{ ...TREE.buildings[0]!, floors: [{ ...TREE.buildings[0]!.floors[0]!, zones: [{ ...TREE.buildings[0]!.floors[0]!.zones[0]!, is_active: lobbyActive }, meeting] }] }],
    })
    let tree = withZones(true)
    const { user } = setup({
      path: '/admin/tracking?tab=locations',
      extra: {
        'GET /locations': () => jsonResponse(tree),
        [`PATCH /locations/zones/${LOBBY.id}`]: () => {
          tree = withZones(false)
          return jsonResponse({ ...LOBBY, floor_id: FLOOR_3.id, is_active: false, created_at: '', updated_at: '' })
        },
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Actions for Lobby' }))
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Archive Lobby?' })
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Actions for Lobby' })).toBeNull())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Actions for Meeting rooms' })).toHaveFocus())
  })

  it('says why a place cannot be restored under an archived one, in its own words', async () => {
    const archived: LocationTree = { buildings: [{ ...TREE.buildings[0]!, floors: [{ ...TREE.buildings[0]!.floors[0]!, is_active: false, zones: [{ ...TREE.buildings[0]!.floors[0]!.zones[0]!, is_active: false }] }] }] }
    const { user } = setup({
      path: '/admin/tracking?tab=locations&archived=1',
      tree: archived,
      extra: {
        [`PATCH /locations/zones/${LOBBY.id}`]: () =>
          errorResponse(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', { fields: { floor_id: 'This location is archived.' }, field_codes: { floor_id: { code: 'location_archived', params: {} } } }),
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Actions for Lobby' }))
    await user.click(screen.getByRole('menuitem', { name: 'Restore' }))
    const toast = await screen.findByText('Lobby could not be restored')
    expect(toast.parentElement).toHaveTextContent('This location is archived.')
    expect(toast.parentElement).not.toHaveTextContent('highlighted')
  })

  it('says why a place in use cannot be archived', async () => {
    const { user } = setup({
      path: '/admin/tracking?tab=locations',
      extra: { [`PATCH /locations/zones/${LOBBY.id}`]: () => errorResponse(409, 'LOCATION_IN_USE', 'This zone still has active cameras.') },
    })
    await user.click(await screen.findByRole('button', { name: 'Actions for Lobby' }))
    await user.click(screen.getByRole('menuitem', { name: 'Archive' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Archive Lobby?' })
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }))
    expect(await within(dialog).findByText('This zone still has active cameras.')).toBeInTheDocument()
  })
})

describe('Visitor tracking (administration): cameras', () => {
  it('lists the cameras with the provider’s ID, the place and the reception mark', async () => {
    setup({ path: '/admin/tracking?tab=cameras', cameras: [makeCamera(), makeCamera({ id: 'c2', name: 'Floor 3 lobby', provider_camera_id: 'cam-f3', is_enrollment_point: false })] })
    const table = await screen.findByRole('table', { name: 'Cameras' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent('Reception desk')
    expect(rows[0]).toHaveTextContent('cam-reception-01')
    expect(rows[0]!.querySelector('[data-location-path]')).toHaveTextContent('North Tower,Floor 3,Lobby')
    expect(rows[0]).toHaveTextContent('Reception camera')
    expect(rows[1]).not.toHaveTextContent('Reception camera')
  })

  it('adds a camera in an active zone, as a reception camera', async () => {
    const { requests, user } = setup({
      path: '/admin/tracking?tab=cameras',
      cameras: [],
      extra: { 'POST /tracking/cameras': () => jsonResponse(makeCamera(), 201) },
    })
    await screen.findByRole('heading', { name: 'No cameras yet' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add camera' })).not.toHaveAttribute('aria-disabled'))
    await user.click(screen.getByRole('button', { name: 'Add camera' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add camera' })
    await user.type(within(dialog).getByRole('textbox', { name: /Provider camera ID/ }), 'cam-reception-01')
    await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Reception desk')
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /Zone/ }), 'Lobby')
    await user.click(within(dialog).getByRole('checkbox', { name: 'Reception camera' }))
    await user.click(within(dialog).getByRole('button', { name: 'Add' }))
    await waitFor(() =>
      expect(sent(requests, 'POST', '/tracking/cameras')).toEqual([{ provider_camera_id: 'cam-reception-01', name: 'Reception desk', zone_id: LOBBY.id, is_enrollment_point: true }]),
    )
  })

  it('archives a camera after one line, the focus going on to the next camera', async () => {
    const floorCamera = makeCamera({ id: 'c2', name: 'Floor 3 lobby', provider_camera_id: 'cam-f3', is_enrollment_point: false })
    let cameras = [makeCamera(), floorCamera]
    const { user } = setup({
      path: '/admin/tracking?tab=cameras',
      extra: {
        'GET /tracking/cameras': () => jsonResponse(cameras),
        [`PATCH /tracking/cameras/${makeCamera().id}`]: () => {
          cameras = [floorCamera]
          return jsonResponse({ ...makeCamera(), is_active: false })
        },
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Archive Reception desk' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Archive Reception desk?' })
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Archive Reception desk' })).toBeNull())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Archive Floor 3 lobby' })).toHaveFocus())
  })

  it('says why a camera whose zone is archived cannot be restored, in its own words', async () => {
    const archived = makeCamera({ is_active: false })
    const { user } = setup({
      path: '/admin/tracking?tab=cameras&archived=1',
      cameras: [archived],
      extra: {
        [`PATCH /tracking/cameras/${archived.id}`]: () =>
          errorResponse(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', { fields: { zone_id: 'This location is archived.' }, field_codes: { zone_id: { code: 'location_archived', params: {} } } }),
      },
    })
    await user.click(await screen.findByRole('button', { name: 'Restore Reception desk' }))
    const toast = await screen.findByText('Reception desk could not be restored')
    expect(toast.parentElement).toHaveTextContent('This location is archived.')
    expect(toast.parentElement).not.toHaveTextContent('highlighted')
  })

  it('leads to the locations first when there is no zone', async () => {
    const { user, router } = setup({ path: '/admin/tracking?tab=cameras', tree: { buildings: [] }, cameras: [] })
    expect(await screen.findByRole('heading', { name: 'Add a zone before adding a camera' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add camera' })).toHaveAttribute('aria-disabled', 'true')
    await user.click(screen.getByRole('button', { name: 'Open locations' }))
    await waitFor(() => expect(router.state.location.search).toBe('?tab=locations'))
  })
})

/** The area alerts' card (Phase 16). */
async function alertsCard(): Promise<HTMLElement> {
  return (await screen.findByRole('heading', { name: 'Tracking alerts' })).closest('section')!
}

describe('Visitor tracking (administration): area alerts (Phase 16)', () => {
  it('turns the area alerts and the host’s e-mail off and on at once', async () => {
    const { requests, user } = setup()
    const card = await alertsCard()
    const areaAlerts = within(card).getByRole('switch', { name: 'Area alerts' })
    const notifyHost = within(card).getByRole('switch', { name: 'Email the host' })
    expect(areaAlerts).toHaveAttribute('aria-checked', 'true')
    expect(notifyHost).toHaveAttribute('aria-checked', 'true')

    await user.click(areaAlerts)
    await waitFor(() => expect(areaAlerts).toHaveAttribute('aria-checked', 'false'))
    await user.click(notifyHost)
    await waitFor(() => expect(notifyHost).toHaveAttribute('aria-checked', 'false'))
    await user.click(areaAlerts)
    await waitFor(() => expect(areaAlerts).toHaveAttribute('aria-checked', 'true'))
    expect(sent(requests, 'PATCH', '/tracking/settings')).toEqual([{ area_alerts_enabled: false }, { alert_notify_host: false }, { area_alerts_enabled: true }])
    expect((await screen.findAllByText('Tracking settings saved')).length).toBeGreaterThan(0)
  })

  it('says when a switch could not be saved, and leaves it as it was', async () => {
    const { user } = setup({ extra: { 'PATCH /tracking/settings': () => errorResponse(503, 'SERVICE_BUSY', 'The service is busy.') } })
    const areaAlerts = within(await alertsCard()).getByRole('switch', { name: 'Area alerts' })
    await user.click(areaAlerts)
    const toast = await screen.findByText('The setting could not be saved')
    expect(toast.parentElement).toHaveTextContent('busy')
    expect(areaAlerts).toHaveAttribute('aria-checked', 'true')
  })

  it('adds and removes alert e-mails, each checked as it is added, and saves the list that changed', async () => {
    const { requests, user } = setup({ settings: makeTrackingSettings({ alert_emails: ['ops@example.com'] }) })
    const card = await alertsCard()
    const list = within(card).getByRole('list', { name: 'Alert emails' })
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['ops@example.comRemove ops@example.com'])
    const field = within(card).getByRole('textbox', { name: 'Email address' })
    const add = within(card).getByRole('button', { name: 'Add' })
    const save = within(card).getByRole('button', { name: 'Save changes to alert emails' })
    expect(save).toHaveAttribute('aria-disabled', 'true')

    await user.click(add)
    expect(field).toHaveAccessibleDescription('Enter an email address.')
    await user.type(field, 'OPS@example.com{Enter}')
    expect(field).toHaveAccessibleDescription('This address is already listed.')
    await user.clear(field)
    await user.type(field, 'Desk@Example.com')
    await user.click(add)
    expect(field).toHaveValue('')
    expect(field).not.toHaveAccessibleDescription()
    expect(within(card).getAllByRole('listitem').map((item) => item.querySelector('[dir="ltr"]')?.textContent)).toEqual(['ops@example.com', 'desk@example.com'])
    expect(within(card).getByRole('status')).toHaveTextContent('You have unsaved changes.')

    // The focus goes on to the next address's remove button.
    await user.click(within(card).getByRole('button', { name: 'Remove ops@example.com' }))
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Remove desk@example.com' })).toHaveFocus())
    expect(sent(requests, 'PATCH', '/tracking/settings')).toEqual([])

    await user.click(save)
    await waitFor(() => expect(sent(requests, 'PATCH', '/tracking/settings')).toEqual([{ alert_emails: ['desk@example.com'] }]))
    await waitFor(() => expect(within(card).getByRole('status')).toHaveTextContent('All changes are saved.'))
    expect(within(card).getAllByRole('listitem')).toHaveLength(1)
  })

  it('discards the list being edited', async () => {
    const { requests, user } = setup({ settings: makeTrackingSettings({ alert_emails: ['ops@example.com'] }) })
    const card = await alertsCard()
    await user.click(within(card).getByRole('button', { name: 'Remove ops@example.com' }))
    // The last one gone: the focus goes to the address field.
    await waitFor(() => expect(within(card).getByRole('textbox', { name: 'Email address' })).toHaveFocus())
    expect(within(card).getByText('None')).toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Discard changes to alert emails' }))
    expect(within(card).getByRole('list', { name: 'Alert emails' })).toHaveTextContent('ops@example.com')
    expect(sent(requests, 'PATCH', '/tracking/settings')).toEqual([])
  })

  it('takes five addresses at most, and says so beside a disabled Add', async () => {
    setup({ settings: makeTrackingSettings({ alert_emails: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com'] }) })
    const card = await alertsCard()
    const add = within(card).getByRole('button', { name: 'Add' })
    expect(add).toHaveAttribute('aria-disabled', 'true')
    expect(add).toHaveAccessibleDescription('At most 5 addresses')
    expect(within(card).getByRole('textbox', { name: 'Email address' })).toBeDisabled()
  })

  it('gives the focus to Add when the fifth address is added with Enter, which disables the field (F16-46)', async () => {
    const { user } = setup({ settings: makeTrackingSettings({ alert_emails: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'] }) })
    const card = await alertsCard()
    const field = within(card).getByRole('textbox', { name: 'Email address' })
    await user.type(field, 'e@example.com{Enter}')
    await waitFor(() => expect(field).toBeDisabled())
    const add = within(card).getByRole('button', { name: 'Add' })
    await waitFor(() => expect(add).toHaveFocus())
    expect(add).toHaveAccessibleDescription('At most 5 addresses')
  })

  it('shows the server’s refusal of an address at the address field', async () => {
    const { user } = setup({
      settings: makeTrackingSettings({ alert_emails: [] }),
      extra: {
        'PATCH /tracking/settings': () =>
          errorResponse(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', {
            fields: { 'alert_emails.0': 'Enter a valid email address.' },
            field_codes: { 'alert_emails.0': { code: 'invalid_email', params: {} } },
          }),
      },
    })
    const card = await alertsCard()
    const field = within(card).getByRole('textbox', { name: 'Email address' })
    await user.type(field, 'ops@example.test{Enter}')
    await user.click(within(card).getByRole('button', { name: 'Save changes to alert emails' }))
    await waitFor(() => expect(field).toHaveAccessibleDescription(/valid email address/))
    expect(within(card).queryByRole('alert')).toBeNull()
  })
})

describe('Visitor tracking (administration): a zone’s access level (Phase 16)', () => {
  it('shows each zone’s access level, and gives a new zone one, standard unless chosen', async () => {
    const { requests, user } = setup({
      path: '/admin/tracking?tab=locations',
      extra: { 'POST /locations/zones': (request) => jsonResponse({ id: 'z9', ...(request.body as object), is_active: true, created_at: '', updated_at: '' }, 201) },
    })
    const zones = await screen.findByRole('list', { name: 'Zones of Floor 3' })
    expect(within(zones).getByRole('listitem').querySelector('[data-zone-access]')).toHaveTextContent('Standard')
    // A floor's level in words beside its name, never a bare number that reads as a count (the owner, F16-32).
    expect(document.querySelector(`[data-floor-level="${FLOOR_3.level}"]`)).toHaveTextContent(`Level ${FLOOR_3.level}`)

    await user.click(screen.getByRole('button', { name: 'Actions for Floor 3' }))
    await user.click(screen.getByRole('menuitem', { name: 'Add zone' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add a zone to Floor 3' })
    const access = within(dialog).getByRole('combobox', { name: 'Access' })
    expect(access).toHaveValue('STANDARD')
    expect(within(access).getAllByRole('option').map((option) => option.textContent)).toEqual(['Standard', 'Common', 'Restricted'])
    await user.type(within(dialog).getByRole('textbox', { name: /^Name/ }), 'Server room')
    await user.selectOptions(access, 'Restricted')
    await user.click(within(dialog).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(sent(requests, 'POST', '/locations/zones')).toEqual([{ floor_id: FLOOR_3.id, name: 'Server room', name_ar: null, access: 'RESTRICTED' }]))
  })

  it('changes a zone’s access level, and asks none of a floor', async () => {
    const { requests, user } = setup({
      path: '/admin/tracking?tab=locations',
      extra: { [`PATCH /locations/zones/${LOBBY.id}`]: (request) => jsonResponse({ ...LOBBY, floor_id: FLOOR_3.id, ...(request.body as object), is_active: true, created_at: '', updated_at: '' }) },
    })
    await user.click(await screen.findByRole('button', { name: 'Actions for Lobby' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit zone Lobby' })
    const access = within(dialog).getByRole('combobox', { name: 'Access' })
    expect(access).toHaveValue('STANDARD')
    await user.selectOptions(access, 'Common')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(sent(requests, 'PATCH', `/locations/zones/${LOBBY.id}`)).toEqual([{ name: 'Lobby', name_ar: 'الردهة', access: 'COMMON' }]))

    await user.click(screen.getByRole('button', { name: 'Actions for Floor 3' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
    const floor = await screen.findByRole('dialog', { name: 'Edit floor Floor 3' })
    expect(within(floor).queryByRole('combobox', { name: 'Access' })).toBeNull()
  })
})

import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { routes } from '../../test/appRoutes'
import { errorResponse, jsonResponse, makeMe, mockApi, type RecordedRequest, type RouteHandler } from '../../test/api'
import { page } from '../../test/fixtures'
import { renderRoutes } from '../../test/render'
import type { CompanySettings, CompanySettingsUpdate } from '../../types/api'
import { makeCompanySettings } from './testRoutes'

const settings = makeCompanySettings()

function patches(requests: RecordedRequest[]) {
  return requests.filter((request) => request.method === 'PATCH' && request.path === '/company/settings')
}

function setup(patch: RouteHandler = (request) => jsonResponse({ ...settings, ...(request.body as CompanySettingsUpdate) } satisfies CompanySettings)) {
  const api = mockApi({
    'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])),
    'GET /company/settings': () => jsonResponse(settings),
    'PATCH /company/settings': patch,
    'GET /users': () => jsonResponse(page([])),
  })
  return { ...api, ...renderRoutes(routes, { initialEntries: ['/admin/settings'] }) }
}

describe('Company settings', () => {
  it('saves only the changed settings and refreshes the session’s company', async () => {
    const { requests, user } = setup()
    const name = await screen.findByLabelText('Company name')
    expect(name).toHaveValue('Acme Holdings')
    expect(screen.getByText('All changes are saved.')).toBeInTheDocument()

    await user.clear(name)
    await user.type(name, 'Acme Group')
    const before = screen.getByLabelText('Valid before the start')
    // A narrow number field with its unit beside it; the hint says the minutes in words.
    expect(before).toHaveClass('max-w-28')
    expect(before.nextElementSibling).toHaveTextContent('min')
    expect(before).toHaveAccessibleDescription(/minutes/)
    // Save stays in reach while the form scrolls.
    expect(screen.getByRole('button', { name: 'Save changes' }).parentElement?.className).toMatch(/(^|\s)sticky(\s|$)/)
    await user.clear(before)
    await user.type(before, '90')
    expect(screen.getByText('90 minutes (1 hour 30 min)')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Allow walk-in visitors' }))
    expect(screen.getByText('You have unsaved changes.')).toBeInTheDocument()

    const meLoads = requests.filter((request) => request.path === '/auth/me').length
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Settings saved')).toBeInTheDocument()
    expect(patches(requests)[0]!.body).toEqual({ name: 'Acme Group', pass_grace_before_minutes: 90, allow_walk_ins: false })
    expect(screen.getByText('All changes are saved.')).toBeInTheDocument()
    await waitFor(() => expect(requests.filter((request) => request.path === '/auth/me').length).toBeGreaterThan(meLoads))
  })

  it('groups the settings in titled cards without explanatory notes (decision 3)', async () => {
    setup()
    await screen.findByLabelText('Company name')
    const main = screen.getByRole('main')
    expect(within(main).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Company',
      'Language and time zone',
      'Visitor passes',
      'Reception',
    ])
    // Toggles keep only their labels; fields keep no hint that explains them.
    expect(screen.getByRole('checkbox', { name: 'Notify the host when their visitor checks in' })).not.toHaveAccessibleDescription()
    expect(screen.getByRole('checkbox', { name: 'Allow walk-in visitors' })).not.toHaveAccessibleDescription()
    expect(screen.getByLabelText('Company name')).not.toHaveAccessibleDescription()
    expect(screen.getByLabelText(/^Address/)).not.toHaveAccessibleDescription()
    expect(screen.getByRole('combobox', { name: 'Time zone' })).not.toHaveAccessibleDescription()
    expect(screen.getByRole('radiogroup', { name: 'Default language' })).not.toHaveAccessibleDescription()
    for (const note of [/Apply to everyone/, /Changes apply/, /Shown in the/, /Printed in/, /follow this time zone/, /The host receives/, /Reception can register/]) {
      expect(main.textContent).not.toMatch(note)
    }
  })

  it('validates the grace periods before sending', async () => {
    const { requests, user } = setup()
    const after = await screen.findByLabelText('Valid after the end')
    await user.clear(after)
    await user.type(after, '1500')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(after).toHaveAttribute('aria-invalid', 'true')
    expect(after).toHaveAccessibleDescription(expect.stringContaining('Enter whole minutes from 0 to 1440 (24 hours).'))
    expect(after).toHaveFocus()
    expect(patches(requests)).toHaveLength(0)
  })

  it('finds a time zone by city and shows the server’s verdict on the field', async () => {
    const { requests, user } = setup(() =>
      errorResponse(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', {
        fields: { timezone: 'Choose a timezone from the list, for example Asia/Amman.' },
      }),
    )
    const zone = await screen.findByRole('combobox', { name: 'Time zone' })
    expect(zone).toHaveValue('Amman — Asia/Amman (UTC+3)')

    await user.clear(zone)
    await user.type(zone, 'new york')
    const listbox = await screen.findByRole('listbox')
    await user.click(within(listbox).getByRole('option', { name: /America\/New_York/ }))
    // The offset depends on the date (daylight saving time).
    expect((zone as HTMLInputElement).value).toMatch(/^New York — America\/New_York \(UTC-[45]\)$/)

    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(zone).toHaveAccessibleDescription(expect.stringContaining('Choose a timezone from the list')))
    expect(patches(requests)[0]!.body).toEqual({ timezone: 'America/New_York' })
  })

  it('asks before leaving with unsaved changes', async () => {
    const { router, user } = setup()
    const name = await screen.findByLabelText('Company name')
    await user.type(name, ' Group')

    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)

    await user.click(screen.getAllByRole('link', { name: 'Users' })[0]!)
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave without saving?' })
    // Each page says what would be lost in its own words (the e-mail texts page once said these: UX review M1).
    expect(dialog).toHaveAccessibleDescription('Your changes to the company settings have not been saved.')
    await user.click(within(dialog).getByRole('button', { name: 'Stay on this page' }))
    expect(router.state.location.pathname).toBe('/admin/settings')
    expect(name).toHaveValue('Acme Holdings Group')

    await user.click(screen.getAllByRole('link', { name: 'Users' })[0]!)
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave without saving' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/users'))
  })

  it('sets the Arabic name and the default language (phase 10: the API had them, the form did not)', async () => {
    const { requests, user } = setup()
    const arabicName = await screen.findByLabelText(/^Arabic name/)
    expect(arabicName).toHaveValue('')
    // Typed right to left whatever the interface language.
    expect(arabicName).toHaveAttribute('dir', 'rtl')
    expect(arabicName).toHaveAttribute('lang', 'ar')
    const language = screen.getByRole('radiogroup', { name: 'Default language' })
    expect(within(language).getByRole('radio', { name: 'English' })).toBeChecked()

    await user.type(arabicName, 'أكمي القابضة')
    await user.click(within(language).getByRole('radio', { name: 'العربية' }))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Settings saved')).toBeInTheDocument()
    expect(patches(requests)[0]!.body).toEqual({ name_ar: 'أكمي القابضة', default_language: 'ar' })
  })

  it('clears the Arabic name with null, so the company name is used again', async () => {
    const withArabicName: CompanySettings = { ...settings, name_ar: 'أكمي' }
    const api = mockApi({
      'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])),
      'GET /company/settings': () => jsonResponse(withArabicName),
      'PATCH /company/settings': (request) => jsonResponse({ ...withArabicName, ...(request.body as CompanySettingsUpdate) }),
      'GET /users': () => jsonResponse(page([])),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/admin/settings'] })
    const arabicName = await screen.findByLabelText(/^Arabic name/)
    expect(arabicName).toHaveValue('أكمي')
    await user.clear(arabicName)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Settings saved')).toBeInTheDocument()
    expect(patches(api.requests)[0]!.body).toEqual({ name_ar: null })
  })

  it('sets, and clears with null, the Arabic address the Arabic e-mails show (phase 10 shared contract B)', async () => {
    const withAddress: CompanySettings = { ...settings, address: '12 King Hussein Street, Amman', address_ar: null }
    let saved = withAddress
    const api = mockApi({
      'GET /auth/me': () => jsonResponse(makeMe(['SYSTEM_ADMIN'])),
      'GET /company/settings': () => jsonResponse(saved),
      'PATCH /company/settings': (request) => {
        saved = { ...saved, ...(request.body as CompanySettingsUpdate) }
        return jsonResponse(saved)
      },
      'GET /users': () => jsonResponse(page([])),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/admin/settings'] })
    const arabicAddress = await screen.findByRole('textbox', { name: 'Arabic address (optional)' })
    // Beside the address, typed right to left, with its label only.
    expect(screen.getByRole('textbox', { name: 'Address (optional)' })).toHaveValue('12 King Hussein Street, Amman')
    expect(arabicAddress).toHaveValue('')
    expect(arabicAddress).toHaveAttribute('dir', 'rtl')
    expect(arabicAddress).toHaveAttribute('lang', 'ar')
    expect(arabicAddress).not.toHaveAccessibleDescription()

    await user.type(arabicAddress, ' 12 شارع الملك حسين، عمّان ')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Settings saved')).toBeInTheDocument()
    expect(patches(api.requests)[0]!.body).toEqual({ address_ar: '12 شارع الملك حسين، عمّان' })
    expect(arabicAddress).toHaveValue('12 شارع الملك حسين، عمّان')

    await user.clear(arabicAddress)
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(patches(api.requests)).toHaveLength(2))
    expect(patches(api.requests)[1]!.body).toEqual({ address_ar: null })
  })

  it('limits the Arabic address as the address', async () => {
    const { requests, user } = setup()
    const arabicAddress = await screen.findByRole('textbox', { name: 'Arabic address (optional)' })
    await user.click(arabicAddress)
    await user.paste('ع'.repeat(1001))
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(arabicAddress).toHaveAccessibleDescription(/1000/)
    expect(patches(requests)).toHaveLength(0)
  })

  it('discards changes on request', async () => {
    const { user } = setup()
    const name = await screen.findByLabelText('Company name')
    await user.type(name, ' Group')
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(name).toHaveValue('Acme Holdings')
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveAttribute('aria-disabled', 'true')
  })
})

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chooseAppearance } from '../../appearance/appearance'
import { coloursOfLogo, iconFromLogo, ImagePipelineError, letterIcon, NEUTRAL_TILE, prepareIcon, prepareLogo, type LetterTile, type PreparedAsset } from '../../identity/imagePipeline'
import { brandTokens } from '../../identity/tokens'
import { routes } from '../../test/appRoutes'
import { errorResponse, jsonResponse, mockApi, type RecordedRequest } from '../../test/api'
import { makeBrand, referencePalette, SAMPLE_COLOURS } from '../../test/palettes'
import { renderRoutes } from '../../test/render'
import type { CompanyBrand, PlatformCompany } from '../../types/api'
import { makePlatformCompany, makePlatformMe, platformRoutes } from './testRoutes'

/*
 * The identity page of a company, for the platform owner (Phase 12). The preparation of a picture
 * is `identity/imagePipeline.test.ts`'s; here it is replaced by doubles that answer a prepared PNG,
 * so the page's own behaviour shows: what is staged, what is asked of the server and in which order.
 */

vi.mock(import('../../identity/imagePipeline'), async (importOriginal) => ({
  ...(await importOriginal()),
  prepareLogo: vi.fn<typeof prepareLogo>(),
  prepareIcon: vi.fn<typeof prepareIcon>(),
  iconFromLogo: vi.fn<typeof iconFromLogo>(),
  letterIcon: vi.fn<typeof letterIcon>(),
  coloursOfLogo: vi.fn<typeof coloursOfLogo>(),
}))

const png = (name: string) => new Blob([`png:${name}`], { type: 'image/png' })
const prepared = (name: string, width: number, height: number, colours: string[] = []): PreparedAsset => ({ blob: png(name), width, height, colours, aspect: width / height })
/** A wordmark: three times as wide as tall, so its icon is the company's letter on its colour. */
const wordmark = () => vi.mocked(prepareLogo).mockImplementation((file) => Promise.resolve(prepared(`logo of ${(file as File).name}`, 600, 200, [BLUE, ORANGE])))
/** The letter tiles the page asked for, in order. */
const tiles = (): LetterTile[] => vi.mocked(letterIcon).mock.calls.map(([tile]) => tile)

const BLUE = SAMPLE_COLOURS.darkBlue
const ORANGE = SAMPLE_COLOURS.orange

/** A company with a logo and a colour, and one with no identity at all. */
const NOVA = makePlatformCompany({ brand: makeBrand('nova-labs', { color: SAMPLE_COLOURS.teal, logo: true, icon: true }) })
const BARE = makePlatformCompany({ id: '9b000000-0000-4000-8000-000000000007', name: 'Bare Co', name_ar: null, slug: 'bare-co' })

const brandPath = (company: PlatformCompany) => `/platform/companies/${company.id}/brand`

function setup(company: PlatformCompany = NOVA, extra: Record<string, (request: RecordedRequest) => Response> = {}) {
  let brand: CompanyBrand = company.brand
  let version = 1
  const changed = (change: Partial<CompanyBrand>) => {
    version += 1
    brand = { ...brand, ...change, version: `v${version}` }
    return jsonResponse(brand)
  }
  const file = (kind: string) => `/api/v1/public/companies/${company.slug}/brand/${kind}.png?v=v${version + 1}`
  const api = mockApi({
    ...platformRoutes({ me: makePlatformMe(), companies: [company] }),
    [`GET /platform/companies/${company.id}`]: () => jsonResponse({ ...company, brand }),
    [`GET /platform/companies/${company.id}/admins`]: () => jsonResponse([]),
    [`PUT ${brandPath(company)}/assets/logo`]: () => changed({ logo_url: file('logo') }),
    [`PUT ${brandPath(company)}/assets/logo_dark`]: () => changed({ logo_dark_url: file('logo_dark') }),
    [`PUT ${brandPath(company)}/assets/icon`]: () => changed({ icon_url: file('icon') }),
    [`DELETE ${brandPath(company)}/assets/logo`]: () => changed({ logo_url: null }),
    [`DELETE ${brandPath(company)}/assets/logo_dark`]: () => changed({ logo_dark_url: null }),
    [`DELETE ${brandPath(company)}/assets/icon`]: () => changed({ icon_url: null }),
    [`PATCH ${brandPath(company)}`]: (request) => {
      const { color } = request.body as { color: string | null }
      return changed({ color, palette: color ? referencePalette(color) : null })
    },
    'POST /platform/brand/palette': (request) => jsonResponse(referencePalette((request.body as { color: string }).color)),
    ...extra,
  })
  return { ...api, ...renderRoutes(routes, { initialEntries: [`/platform/companies/${company.id}/identity`] }) }
}

const slot = (kind: string) => document.querySelector<HTMLElement>(`[data-asset-slot="${kind}"]`) as HTMLElement
const fileInput = (kind: string) => document.querySelector<HTMLInputElement>(`[data-asset-input="${kind}"]`) as HTMLInputElement
const preview = (kind: string) => slot(kind).querySelector<HTMLImageElement>('[data-asset-preview] img')
const colourField = () => screen.getByRole('textbox', { name: 'Colour' }) as HTMLInputElement
/** What changed the company's identity on the server (the palette preview changes nothing). */
const brandRequests = (requests: RecordedRequest[]) =>
  requests.filter((request) => request.path.includes('/companies/') && request.path.includes('/brand') && request.method !== 'GET').map((request) => `${request.method} ${request.path}`)
/** The bytes a request uploaded, as text (the doubles' PNGs say what they are); null when it uploaded none. */
const uploaded = (request: RecordedRequest | undefined) => (request?.body instanceof Blob ? request.body.text() : Promise.resolve(null))
/** The page's line that says whether anything is unsaved. */
const status = () => document.querySelector<HTMLElement>('[data-identity-status]')
/** The inline style of a part of the preview's e-mail (its colours are the palette's own, set as the server writes them). */
const emailStyle = (part: string) => document.querySelector<HTMLElement>(`[data-preview="email"] [data-preview-${part}]`)?.style
/** A colour as the DOM gives an inline one back (`rgb(r, g, b)`). */
const rgbOf = (hex: string) => `rgb(${[1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)).join(', ')})`
const paletteRequests = (requests: RecordedRequest[]) => requests.filter((request) => request.path === '/platform/brand/palette').map((request) => (request.body as { color: string }).color)

/** The colour behind the logo for dark surfaces, in its place on the page. */
const dark = () => document.querySelector<HTMLElement>('[data-asset-preview="logo_dark"]')?.style.backgroundColor
/** The button that saves what is staged. */
const save = () => screen.getByRole('button', { name: 'Save identity' })
/** The preview's small shell. */
const shell = () => document.querySelector<HTMLElement>('[data-preview-shell]')

const LOGO_FILE = new File(['the original bytes of a JPEG'], 'nova.jpg', { type: 'image/jpeg' })

beforeEach(() => {
  let urls = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:identity/${(urls += 1)}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  // A double's answers queued by one test never reach the next.
  for (const double of [prepareLogo, prepareIcon, iconFromLogo, letterIcon, coloursOfLogo]) vi.mocked(double).mockReset()
  // A lockup that fits a square (3:2): its icon is the logo on a white tile.
  vi.mocked(prepareLogo).mockImplementation((file) => Promise.resolve(prepared(`logo of ${(file as File).name}`, 600, 400, [BLUE, ORANGE])))
  vi.mocked(iconFromLogo).mockImplementation(() => Promise.resolve(prepared('icon made from the logo', 512, 512)))
  vi.mocked(letterIcon).mockImplementation((tile) => Promise.resolve(prepared(`letter ${tile.letter} in ${tile.ink} on ${tile.background}`, 512, 512)))
  vi.mocked(prepareIcon).mockImplementation((file) => Promise.resolve(prepared(`icon of ${(file as File).name}`, 512, 512)))
  vi.mocked(coloursOfLogo).mockResolvedValue([SAMPLE_COLOURS.teal])
})

describe('a company’s identity page', () => {
  it('shows the saved identity: the logo, the icon, the colour with the logo’s own colours, and the sign-in link', async () => {
    const { requests } = setup()
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    // The way back names the company, and so does the tab's title: no two companies' pages are called the same.
    expect(screen.getByRole('link', { name: 'Nova Labs' })).toHaveAttribute('href', `/platform/companies/${NOVA.id}`)
    await waitFor(() => expect(document.title).toBe('Identity · Nova Labs · Mawdoo3 Visitors'))
    // Whose identity it is heads the page: the company's logo and its name right above the title.
    const header = screen.getByRole('heading', { level: 1, name: 'Identity' }).closest('header') as HTMLElement
    expect(header.querySelector('[data-page-subject]')).toHaveTextContent('Nova Labs')
    expect(header.querySelector('[data-company-logo-tile] img')).toHaveAttribute('src', NOVA.brand.logo_url)
    expect(header.querySelector('[data-company-logo-tile] img')).toHaveAttribute('alt', '')

    expect(preview('logo')).toHaveAttribute('src', NOVA.brand.logo_url)
    expect(preview('logo')).toHaveAttribute('alt', 'Logo of Nova Labs')
    expect(preview('icon')).toHaveAttribute('src', NOVA.brand.icon_url)
    expect(slot('logo_dark')).toHaveTextContent('None')
    expect(within(slot('logo')).getByRole('button', { name: 'Replace: Logo' })).toHaveTextContent('Replace')
    expect(within(slot('logo_dark')).getByRole('button', { name: 'Choose image: Logo for dark surfaces' })).toHaveTextContent('Choose image')
    expect(within(slot('logo_dark')).queryByRole('button', { name: /Remove/ })).toBeNull()

    expect(colourField()).toHaveValue(SAMPLE_COLOURS.teal)
    expect(screen.getByLabelText('Colour picker')).toHaveValue(SAMPLE_COLOURS.teal)
    // The suggestions come from the saved logo's own pixels.
    const suggestions = await screen.findByRole('group', { name: 'Colours from the logo' })
    expect(coloursOfLogo).toHaveBeenCalledWith(NOVA.brand.logo_url)
    expect(within(suggestions).getByRole('button', { name: SAMPLE_COLOURS.teal })).toHaveAttribute('aria-pressed', 'true')

    const link = document.querySelector('[data-sign-in-link]')
    expect(link).toHaveTextContent(`${window.location.origin}/c/nova-labs`)
    expect(link).toHaveAttribute('dir', 'ltr')
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()

    expect(status()).toHaveTextContent('All changes are saved.')
    expect(screen.getByRole('button', { name: 'Save identity' })).toHaveAttribute('aria-disabled', 'true')
    // The saved colour's palette came with the company: nothing is asked for it.
    expect(paletteRequests(requests)).toEqual([])
    expect(screen.getByRole('img', { name: 'Preview of the identity of Nova Labs' })).toBeInTheDocument()
  })

  it('stages a chosen logo, makes the icon from it, suggests its colours, previews the palette and saves it all', async () => {
    const { user, requests } = setup(BARE)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    expect(screen.queryByRole('group', { name: 'Colours from the logo' })).toBeNull()
    // Nothing yet: the e-mail is headed by the company's name, in the default colours.
    expect(document.querySelector('[data-preview="email"] [data-preview-wordmark]')).toHaveTextContent('Bare Co')
    expect(emailStyle('wordmark')?.color).toBe('rgb(20, 110, 115)')
    expect(emailStyle('rule')?.backgroundColor).toBe('rgb(24, 128, 134)')
    expect(document.querySelector('[data-preview-pill]')).toHaveTextContent('Visit invitation')

    await user.upload(fileInput('logo'), LOGO_FILE)

    // Prepared on this device, shown from the prepared PNG, and not saved yet.
    await waitFor(() => expect(preview('logo')).toHaveAttribute('src', 'blob:identity/1'))
    expect(prepareLogo).toHaveBeenCalledWith(LOGO_FILE, 'light')
    expect(slot('logo')).toHaveTextContent('600 × 400 px')
    expect(slot('logo')).toHaveTextContent('Not saved yet')
    // The square icon follows the logo.
    await waitFor(() => expect(preview('icon')).toHaveAttribute('src', 'blob:identity/2'))
    expect(slot('icon')).toHaveTextContent('Made from the logo')
    // Made from the prepared PNG, not from the chosen file.
    const stagedLogo = (await vi.mocked(prepareLogo).mock.results[0]?.value) as PreparedAsset | undefined
    expect(stagedLogo?.blob).toBeInstanceOf(Blob)
    expect(vi.mocked(iconFromLogo).mock.calls[0]?.[0]).toBe(stagedLogo?.blob)
    expect(brandRequests(requests)).toEqual([])
    expect(status()).toHaveTextContent('You have unsaved changes.')

    // The logo's colours, most used first; one tap chooses one.
    const suggestions = screen.getByRole('group', { name: 'Colours from the logo' })
    expect(within(suggestions).getAllByRole('button').map((button) => button.textContent)).toEqual([BLUE, ORANGE])
    await user.click(within(suggestions).getByRole('button', { name: BLUE }))
    expect(colourField()).toHaveValue(BLUE)
    expect(screen.getByLabelText('Colour picker')).toHaveValue(BLUE)
    expect(within(suggestions).getByRole('button', { name: BLUE })).toHaveAttribute('aria-pressed', 'true')

    // The live preview: the server's palette for that colour, on the preview alone.
    await waitFor(() => expect(paletteRequests(requests)).toEqual([BLUE]))
    const palette = referencePalette(BLUE)
    await waitFor(() => expect(document.querySelector<HTMLElement>('[data-preview-shell]')?.style.getPropertyValue('--color-shell')).toBe(palette.surface))
    expect(document.querySelector<HTMLElement>('[data-preview="app"]')?.style.getPropertyValue('--color-accent')).toBe(palette.surface)
    // The e-mail's head as the server lays it out: the bar and the button in the colour, the logo on
    // white, the kind of message in the colour on its tint.
    expect(emailStyle('email-button')?.backgroundColor).toBe('rgb(30, 58, 138)')
    expect(emailStyle('rule')?.backgroundColor).toBe('rgb(30, 58, 138)')
    expect(emailStyle('pill')?.color).toBe('rgb(30, 58, 138)')
    expect(emailStyle('pill')?.backgroundColor).toBe(rgbOf(palette.tint))
    expect(document.querySelector('[data-preview="email"] img')).toHaveAttribute('src', 'blob:identity/1')
    expect(document.querySelector('[data-preview="email"] [data-preview-wordmark]')).toBeNull()
    expect(document.querySelector('[data-preview-shell] img')).toHaveAttribute('src', 'blob:identity/1')
    // The platform's own page keeps the product's colours.
    expect(document.documentElement.style.getPropertyValue('--brand-light-accent')).toBe('')

    await user.click(screen.getByRole('button', { name: 'Save identity' }))
    expect(await screen.findByText('Identity saved')).toBeInTheDocument()

    // A file per request, the logo before the icon made from it, then the colour.
    expect(brandRequests(requests)).toEqual([`PUT ${brandPath(BARE)}/assets/logo`, `PUT ${brandPath(BARE)}/assets/icon`, `PATCH ${brandPath(BARE)}`])
    const uploads = requests.filter((request) => request.method === 'PUT')
    for (const upload of uploads) {
      expect(upload.headers.get('Content-Type')).toBe('image/png')
      expect(upload.body).toBeInstanceOf(Blob)
    }
    // The prepared PNG is what leaves: never the bytes of the chosen file.
    expect(await uploaded(uploads[0])).toBe('png:logo of nova.jpg')
    expect(await uploaded(uploads[1])).toBe('png:icon made from the logo')
    expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({ color: BLUE })

    // Saved: the page shows the server's files, nothing is staged.
    await waitFor(() => expect(preview('logo')).toHaveAttribute('src', `/api/v1/public/companies/bare-co/brand/logo.png?v=v2`))
    expect(slot('logo')).not.toHaveTextContent('Not saved yet')
    expect(status()).toHaveTextContent('All changes are saved.')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:identity/1')
  })

  it('takes the colour typed as hex or picked, and asks for its palette once the typing stops', async () => {
    const { user, requests } = setup(BARE)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })

    await user.type(colourField(), '#F97316')
    expect(screen.getByLabelText('Colour picker')).toHaveValue(ORANGE)
    await waitFor(() => expect(paletteRequests(requests)).toEqual([ORANGE]))
    // Not once per key: half-typed text is no colour, and the last one is asked for once.
    expect(paletteRequests(requests)).toHaveLength(1)

    fireEvent.change(screen.getByLabelText('Colour picker'), { target: { value: '#7C3AED' } })
    expect(colourField()).toHaveValue('#7c3aed')

    await user.click(screen.getByRole('button', { name: 'Save identity' }))
    expect(await screen.findByText('Identity saved')).toBeInTheDocument()
    expect(brandRequests(requests)).toEqual([`PATCH ${brandPath(BARE)}`])
    expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({ color: '#7c3aed' })
  })

  it('refuses a colour that is none, on the field, and sends nothing', async () => {
    const { user, requests } = setup()
    await screen.findByRole('heading', { level: 1, name: 'Identity' })

    await user.clear(colourField())
    await user.type(colourField(), 'teal')
    await user.click(screen.getByRole('button', { name: 'Save identity' }))

    expect(await screen.findByText('Enter the colour as six hex digits, like #188086.')).toBeInTheDocument()
    expect(colourField()).toHaveAttribute('aria-invalid', 'true')
    expect(colourField()).toHaveFocus()
    expect(brandRequests(requests)).toEqual([])
    // An emptied field is no way to remove a saved colour either: that is "Reset to default colour".
    await user.clear(colourField())
    await user.click(screen.getByRole('button', { name: 'Save identity' }))
    expect(brandRequests(requests)).toEqual([])

    // Corrected: the message goes as it is typed.
    await user.type(colourField(), ORANGE)
    expect(screen.queryByText('Enter the colour as six hex digits, like #188086.')).toBeNull()
  })

  it('removes a saved file after one line of confirmation', async () => {
    const company = makePlatformCompany({ brand: makeBrand('nova-labs', { color: SAMPLE_COLOURS.teal, logo: true }) })
    const { user, requests } = setup(company)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })

    await user.click(within(slot('logo')).getByRole('button', { name: 'Remove: Logo' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove the logo?' })
    expect(dialog).toHaveTextContent('The app, the emails and the visitor passes show the company’s name instead.'.replace('’', "'"))
    expect(dialog).not.toHaveTextContent('app icon')
    expect(brandRequests(requests)).toEqual([])

    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('Logo removed')).toBeInTheDocument()
    expect(brandRequests(requests)).toEqual([`DELETE ${brandPath(company)}/assets/logo`])
    await waitFor(() => expect(preview('logo')).toBeNull())
    expect(slot('logo')).toHaveTextContent('None')
    // Without a logo there is nothing to suggest colours from.
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Colours from the logo' })).toBeNull())
  })

  it('removes the app icon with the logo, and says so in the same one line (UX review: the icon made from a removed logo stayed)', async () => {
    const { user, requests } = setup()
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    expect(preview('icon')).toHaveAttribute('src', NOVA.brand.icon_url)

    await user.click(within(slot('logo')).getByRole('button', { name: 'Remove: Logo' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove the logo?' })
    expect(dialog).toHaveTextContent("The app, the emails and the visitor passes show the company's name instead, and the app icon is removed with it.")
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))

    expect(await screen.findByText('Logo and app icon removed')).toBeInTheDocument()
    // The logo, then its icon: a request each.
    expect(brandRequests(requests)).toEqual([`DELETE ${brandPath(NOVA)}/assets/logo`, `DELETE ${brandPath(NOVA)}/assets/icon`])
    await waitFor(() => expect(preview('icon')).toBeNull())
    expect(preview('logo')).toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(status()).toHaveTextContent('All changes are saved.')
  })

  it('keeps an icon that was chosen by hand during this visit when the logo is removed', async () => {
    const { user, requests } = setup()
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    // Replaced by hand and saved: the page knows this icon is not the logo's.
    await user.upload(fileInput('icon'), new File(['icon'], 'mark.png', { type: 'image/png' }))
    await waitFor(() => expect(slot('icon')).toHaveTextContent('Not saved yet'))
    await user.click(screen.getByRole('button', { name: 'Save identity' }))
    expect(await screen.findByText('Identity saved')).toBeInTheDocument()

    await user.click(within(slot('logo')).getByRole('button', { name: 'Remove: Logo' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove the logo?' })
    expect(dialog).not.toHaveTextContent('app icon')
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('Logo removed')).toBeInTheDocument()
    expect(brandRequests(requests)).toEqual([`PUT ${brandPath(NOVA)}/assets/icon`, `DELETE ${brandPath(NOVA)}/assets/logo`])
    expect(preview('icon')).not.toBeNull()
  })

  it('keeps an icon chosen by hand and not saved yet, too, and leaves what is removed removed when the icon’s removal fails', async () => {
    const first = setup()
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    await first.user.upload(fileInput('icon'), new File(['icon'], 'mark.png', { type: 'image/png' }))
    await waitFor(() => expect(slot('icon')).toHaveTextContent('Not saved yet'))
    await first.user.click(within(slot('logo')).getByRole('button', { name: 'Remove: Logo' }))
    expect(await screen.findByRole('alertdialog', { name: 'Remove the logo?' })).not.toHaveTextContent('app icon')
    first.unmount()

    const { user, requests } = setup(NOVA, { [`DELETE ${brandPath(NOVA)}/assets/icon`]: () => errorResponse(503, 'SERVICE_BUSY', 'The service is busy. Please try again.') })
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    await user.click(within(slot('logo')).getByRole('button', { name: 'Remove: Logo' }))
    await user.click(within(await screen.findByRole('alertdialog', { name: 'Remove the logo?' })).getByRole('button', { name: 'Remove' }))
    expect(await screen.findByText('The image could not be removed')).toBeInTheDocument()
    expect(brandRequests(requests)).toEqual([`DELETE ${brandPath(NOVA)}/assets/logo`, `DELETE ${brandPath(NOVA)}/assets/icon`])
    // The logo is gone and the icon is still there: the question is closed, and "Remove" on the icon asks its own.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    await waitFor(() => expect(preview('logo')).toBeNull())
    expect(preview('icon')).not.toBeNull()
  })

  it('says what is lost with each file, in one line', async () => {
    const company = makePlatformCompany({ brand: makeBrand('nova-labs', { logo: true, logoDark: true, icon: true }) })
    const { user } = setup(company)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })

    await user.click(within(slot('logo_dark')).getByRole('button', { name: 'Remove: Logo for dark surfaces' }))
    let dialog = await screen.findByRole('alertdialog', { name: 'Remove the logo for dark surfaces?' })
    expect(dialog).toHaveTextContent('Dark surfaces show the logo on a white plate instead.')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await user.click(within(slot('icon')).getByRole('button', { name: 'Remove: App icon' }))
    dialog = await screen.findByRole('alertdialog', { name: 'Remove the app icon?' })
    expect(dialog).toHaveTextContent('Browser tabs and the installed app show a neutral icon instead.')
  })

  it('drops a picture that is only staged without asking: nothing saved is lost', async () => {
    const { user, requests } = setup(BARE)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    await user.upload(fileInput('logo'), LOGO_FILE)
    await waitFor(() => expect(preview('icon')).not.toBeNull())

    await user.click(within(slot('logo')).getByRole('button', { name: 'Remove: Logo' }))

    expect(screen.queryByRole('alertdialog')).toBeNull()
    // The icon that was made from it goes with it.
    expect(preview('logo')).toBeNull()
    expect(preview('icon')).toBeNull()
    expect(brandRequests(requests)).toEqual([])
    expect(status()).toHaveTextContent('All changes are saved.')
  })

  it('makes the icon of a wordmark from the company’s letter on its colour, and draws it again when the colour changes (UX review: a white tile with a speck)', async () => {
    wordmark()
    const { user, requests } = setup(BARE)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })

    await user.upload(fileInput('logo'), LOGO_FILE)
    // No colour yet: the company's first letter on the neutral tile. The logo itself is not put on a tile.
    await waitFor(() => expect(preview('icon')).not.toBeNull())
    expect(tiles()).toEqual([{ letter: 'B', ...NEUTRAL_TILE }])
    expect(iconFromLogo).not.toHaveBeenCalled()
    expect(slot('icon')).toHaveTextContent('Made from the name')
    expect(slot('icon')).not.toHaveTextContent('Made from the logo')
    // "Replace" stays: the letter is only what the page offers.
    expect(within(slot('icon')).getByRole('button', { name: 'Replace: App icon' })).toBeInTheDocument()

    // A colour from the logo: once its palette is known, the tile is the company's surface under its ink.
    await user.click(screen.getByRole('button', { name: ORANGE }))
    const palette = referencePalette(ORANGE)
    await waitFor(() => expect(tiles()).toEqual([{ letter: 'B', ...NEUTRAL_TILE }, { letter: 'B', background: palette.surface, ink: palette.on_surface }]))
    // Orange is a light surface: the tile is the orange itself, the letter dark.
    expect(palette.surface).toBe(ORANGE)
    expect(palette.on_surface).not.toBe('#ffffff')
    await waitFor(() => expect(slot('icon')).toHaveTextContent('Made from the name'))

    await user.click(screen.getByRole('button', { name: 'Save identity' }))
    expect(await screen.findByText('Identity saved')).toBeInTheDocument()
    expect(await uploaded(requests.filter((request) => request.method === 'PUT')[1])).toBe(`png:letter B in ${palette.on_surface} on ${ORANGE}`)
    expect(status()).toHaveTextContent('All changes are saved.')

    // Later in the same visit the colour changes: the saved tile is the page's own, and follows.
    await user.clear(colourField())
    await user.type(colourField(), BLUE)
    const blue = referencePalette(BLUE)
    await waitFor(() => expect(tiles().at(-1)).toEqual({ letter: 'B', background: blue.surface, ink: '#ffffff' }))
    await waitFor(() => expect(slot('icon')).toHaveTextContent('Not saved yet'))
    // Back at the saved colour: the saved icon is that tile already, and nothing of the icon is left to save.
    const drawn = tiles().length
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect(status()).toHaveTextContent('All changes are saved.'))
    expect(slot('icon')).not.toHaveTextContent('Not saved yet')
    expect(tiles()).toHaveLength(drawn)
  })

  it('holds “Save identity” while the letter tile is drawn in a new colour: the icon is never saved in the colour before', async () => {
    wordmark()
    const { user, requests } = setup(BARE)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    await user.upload(fileInput('logo'), LOGO_FILE)
    await waitFor(() => expect(preview('icon')).not.toBeNull())
    expect(save()).not.toHaveAttribute('aria-disabled', 'true')

    // The next tile takes its time.
    const held: { draw?: () => void } = {}
    vi.mocked(letterIcon).mockImplementationOnce(
      (tile) =>
        new Promise((resolve) => {
          held.draw = () => resolve(prepared(`letter ${tile.letter} in ${tile.ink} on ${tile.background}`, 512, 512))
        }),
    )
    await user.type(colourField(), ORANGE)
    // The colour's palette is on its way, then the tile is being drawn: the button waits for both.
    expect(save()).toHaveAttribute('aria-disabled', 'true')
    await waitFor(() => expect(held.draw).toBeDefined())
    expect(save()).toHaveAttribute('aria-disabled', 'true')
    await user.click(save())
    expect(brandRequests(requests)).toEqual([])

    held.draw?.()
    await waitFor(() => expect(save()).not.toHaveAttribute('aria-disabled', 'true'))
    await user.click(save())
    expect(await screen.findByText('Identity saved')).toBeInTheDocument()
    const palette = referencePalette(ORANGE)
    expect(await uploaded(requests.filter((request) => request.method === 'PUT')[1])).toBe(`png:letter B in ${palette.on_surface} on ${ORANGE}`)
  })

  it('does not hold the page for a tile that cannot be drawn: the one on the page is saved', async () => {
    wordmark()
    const { user, requests } = setup(BARE)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    await user.upload(fileInput('logo'), LOGO_FILE)
    await waitFor(() => expect(preview('icon')).not.toBeNull())
    vi.mocked(letterIcon).mockRejectedValueOnce(new Error('The canvas failed'))
    await user.type(colourField(), ORANGE)
    await waitFor(() => expect(tiles()).toHaveLength(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save identity' })).not.toHaveAttribute('aria-disabled', 'true'))
    // Not drawn again and again either.
    expect(tiles()).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'Save identity' }))
    expect(await screen.findByText('Identity saved')).toBeInTheDocument()
    expect(await uploaded(requests.filter((request) => request.method === 'PUT')[1])).toBe(`png:letter B in ${NEUTRAL_TILE.ink} on ${NEUTRAL_TILE.background}`)
  })

  it('takes the letter from the name the company’s people read first, in its own script', async () => {
    wordmark()
    const arabic = makePlatformCompany({ id: '9b000000-0000-4000-8000-000000000008', name: 'Arab Bank', name_ar: 'البنك العربي', slug: 'arab-bank', default_language: 'ar' })
    const first = setup(arabic)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    await first.user.upload(fileInput('logo'), LOGO_FILE)
    // The first letter after the article: «ب», not «ا».
    await waitFor(() => expect(tiles()).toEqual([{ letter: 'ب', ...NEUTRAL_TILE }]))
    first.unmount()

    vi.mocked(letterIcon).mockClear()
    const english = makePlatformCompany({ id: '9b000000-0000-4000-8000-000000000009', name: 'Arab Bank', name_ar: 'البنك العربي', slug: 'arab-bank-en', default_language: 'en' })
    const { user } = setup(english)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    await user.upload(fileInput('logo'), LOGO_FILE)
    await waitFor(() => expect(tiles()).toEqual([{ letter: 'A', ...NEUTRAL_TILE }]))
  })

  it('leaves an icon chosen by hand, and a saved one it did not make, as they are when the colour changes', async () => {
    const { user } = setup()
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    // NOVA's icon was saved before this visit: nobody's to redraw.
    await user.clear(colourField())
    await user.type(colourField(), ORANGE)
    await waitFor(() => expect(document.querySelector<HTMLElement>('[data-preview-shell]')?.style.getPropertyValue('--color-shell')).toBe(ORANGE))
    expect(letterIcon).not.toHaveBeenCalled()
    expect(preview('icon')).toHaveAttribute('src', NOVA.brand.icon_url)

    // One chosen by hand now is left alone too, by a new logo and by another colour.
    wordmark()
    await user.upload(fileInput('icon'), new File(['icon'], 'mark.png', { type: 'image/png' }))
    await waitFor(() => expect(slot('icon')).toHaveTextContent('Not saved yet'))
    await user.upload(fileInput('logo'), LOGO_FILE)
    await waitFor(() => expect(slot('logo')).toHaveTextContent('Not saved yet'))
    await user.clear(colourField())
    await user.type(colourField(), BLUE)
    await waitFor(() => expect(document.querySelector<HTMLElement>('[data-preview-shell]')?.style.getPropertyValue('--color-shell')).toBe(BLUE))
    expect(letterIcon).not.toHaveBeenCalled()
    expect(iconFromLogo).not.toHaveBeenCalled()
    expect(slot('icon')).not.toHaveTextContent('Made from')
  })

  it('prepares each logo for the background it is for, and says where a logo that would not show there belongs', async () => {
    const { user } = setup(BARE)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })

    // A white logo in the place for white backgrounds: refused, with the place it belongs in.
    vi.mocked(prepareLogo).mockRejectedValueOnce(new ImagePipelineError('too-light'))
    await user.upload(fileInput('logo'), LOGO_FILE)
    expect(await within(slot('logo')).findByText('This logo is too light to show on a white background. Choose a dark version here, and use this one as the “Logo for dark surfaces”.')).toBeInTheDocument()
    expect(prepareLogo).toHaveBeenLastCalledWith(LOGO_FILE, 'light')
    expect(preview('logo')).toBeNull()
    expect(preview('icon')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save identity' })).toHaveAttribute('aria-disabled', 'true')

    // The mirror: a black logo in the place for dark surfaces.
    vi.mocked(prepareLogo).mockRejectedValueOnce(new ImagePipelineError('too-dark'))
    await user.upload(fileInput('logo_dark'), LOGO_FILE)
    expect(await within(slot('logo_dark')).findByText('This logo is too dark to show on a dark background. Choose a light version here, and use this one as the “Logo”.')).toBeInTheDocument()
    expect(prepareLogo).toHaveBeenLastCalledWith(LOGO_FILE, 'dark')

    // The same white file there is what that place is for.
    await user.upload(fileInput('logo_dark'), LOGO_FILE)
    await waitFor(() => expect(preview('logo_dark')).not.toBeNull())
    expect(within(slot('logo_dark')).queryByText(/too dark/)).toBeNull()

    // A white picture as the icon would be a blank tile.
    vi.mocked(prepareIcon).mockRejectedValueOnce(new ImagePipelineError('too-light'))
    await user.upload(fileInput('icon'), LOGO_FILE)
    expect(await within(slot('icon')).findByText('This image is too light to show on a white background. Choose a darker one.')).toBeInTheDocument()
  })

  it.each([
    ['too-wide', 'This logo is too wide. Choose one that is at most 8 times as wide as it is tall.'],
    ['too-tall', 'This logo is too tall. Choose one that is at most twice as tall as it is wide.'],
    ['too-small', 'This image is too small. Choose one that is at least 96 pixels on its longer side.'],
  ] as const)('says what is wrong with a logo’s shape or size (%s) instead of taking it as it is', async (problem, message) => {
    vi.mocked(prepareLogo).mockRejectedValueOnce(new ImagePipelineError(problem))
    const { user, requests } = setup(BARE)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    await user.upload(fileInput('logo'), LOGO_FILE)
    expect(await within(slot('logo')).findByText(message)).toBeInTheDocument()
    expect(preview('logo')).toBeNull()
    expect(brandRequests(requests)).toEqual([])
  })

  it('shows the logo for dark surfaces on the surface it is drawn on: the shell’s colour, or the deep step for a company whose shell is light', async () => {
    const { user } = setup(BARE)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    expect(dark()).toBe('rgb(24, 128, 134)')
    await user.type(colourField(), BLUE)
    await waitFor(() => expect(dark()).toBe(rgbOf(referencePalette(BLUE).surface)))
    // A yellow company's shell is yellow under dark ink: a logo for dark surfaces is never drawn on it.
    await user.clear(colourField())
    await user.type(colourField(), SAMPLE_COLOURS.amber)
    await waitFor(() => expect(dark()).toBe(rgbOf(referencePalette(SAMPLE_COLOURS.amber).deep)))
  })

  it('previews a light colour as it will look: the shell and the buttons in the colour itself, under dark ink', async () => {
    const { user } = setup(BARE)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    await user.type(colourField(), SAMPLE_COLOURS.amber)
    const palette = referencePalette(SAMPLE_COLOURS.amber)
    await waitFor(() => expect(shell()?.style.getPropertyValue('--color-shell')).toBe(SAMPLE_COLOURS.amber))
    // Everything on the shell follows its ink; the current page is an ink pill with the colour as its text.
    expect(shell()?.style.getPropertyValue('--color-fg')).toBe(palette.on_surface)
    expect(shell()?.style.getPropertyValue('--color-accent')).toBe(palette.on_surface)
    expect(shell()?.style.getPropertyValue('--color-on-accent')).toBe(SAMPLE_COLOURS.amber)
    const app = document.querySelector<HTMLElement>('[data-preview="app"]')
    expect(app?.style.getPropertyValue('--color-accent')).toBe(SAMPLE_COLOURS.amber)
    expect(app?.style.getPropertyValue('--color-on-accent')).toBe(palette.on_surface)
    // Links on white keep the darker step, which reads there.
    expect(app?.style.getPropertyValue('--color-accent-text')).not.toBe(SAMPLE_COLOURS.amber)
    // The e-mail: the bar and the button in the colour, the button's text in its ink, its edge the step that shows on white.
    expect(emailStyle('rule')?.backgroundColor).toBe(rgbOf(SAMPLE_COLOURS.amber))
    expect(emailStyle('email-button')?.backgroundColor).toBe(rgbOf(SAMPLE_COLOURS.amber))
    expect(emailStyle('email-button')?.color).toBe(rgbOf(palette.on_surface))
    expect(emailStyle('email-button')?.borderColor).toBe(rgbOf(palette.strong))
    expect(emailStyle('pill')?.color).toBe(rgbOf(palette.strong))
  })

  it('previews the app in the colour scheme of this device’s appearance, and follows a change of it (Phase 13)', async () => {
    const { user } = setup(BARE)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    await user.type(colourField(), SAMPLE_COLOURS.amber)
    const palette = referencePalette(SAMPLE_COLOURS.amber)
    await waitFor(() => expect(shell()?.style.getPropertyValue('--color-shell')).toBe(SAMPLE_COLOURS.amber))
    // The device chose Dark: the shell is the deep one and the content takes the dark set, as the app does.
    act(() => chooseAppearance('dark'))
    await waitFor(() => expect(shell()?.style.getPropertyValue('--color-shell')).toBe(palette.deep))
    const tokens = brandTokens(palette)
    expect(document.querySelector<HTMLElement>('[data-preview="app"]')?.style.getPropertyValue('--color-accent')).toBe(tokens.dark.accent)
    act(() => chooseAppearance('light'))
    await waitFor(() => expect(shell()?.style.getPropertyValue('--color-shell')).toBe(SAMPLE_COLOURS.amber))
  })

  it('resets to the default colour after one line of confirmation', async () => {
    const { user, requests } = setup()
    await screen.findByRole('heading', { level: 1, name: 'Identity' })

    await user.click(screen.getByRole('button', { name: 'Reset to default colour' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Reset to the default colour?' })
    expect(dialog).toHaveTextContent('The app, the emails and the visitor passes go back to the default colours.')
    await user.click(within(dialog).getByRole('button', { name: 'Reset colour' }))

    expect(await screen.findByText('Default colour restored')).toBeInTheDocument()
    expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({ color: null })
    expect(colourField()).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Reset to default colour' })).toHaveAttribute('aria-disabled', 'true')
    // The preview is back on the default colours.
    await waitFor(() => expect(document.querySelector<HTMLElement>('[data-preview-shell]')?.style.getPropertyValue('--color-shell')).toBe(''))
  })

  it('clears a colour that was only typed without asking, when the company has none saved', async () => {
    const { user, requests } = setup(BARE)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    await user.type(colourField(), ORANGE)

    await user.click(screen.getByRole('button', { name: 'Reset to default colour' }))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(colourField()).toHaveValue('')
    expect(brandRequests(requests)).toEqual([])
  })

  it('refuses a file that is no image with a clear message, and stages nothing', async () => {
    vi.mocked(prepareLogo).mockRejectedValueOnce(new ImagePipelineError('undecodable'))
    const { requests } = setup(BARE)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })

    // The picker's filter is advice: "All files" lets anything through, and the page must say no itself.
    fireEvent.change(fileInput('logo'), { target: { files: [new File(['%PDF-1.7'], 'brochure.pdf', { type: 'application/pdf' })] } })

    expect(await within(slot('logo')).findByText('This file cannot be read as an image. Choose a PNG, JPEG, WebP, SVG file.')).toBeInTheDocument()
    expect(preview('logo')).toBeNull()
    expect(iconFromLogo).not.toHaveBeenCalled()
    expect(brandRequests(requests)).toEqual([])
    expect(screen.getByRole('button', { name: 'Save identity' })).toHaveAttribute('aria-disabled', 'true')
  })

  it.each([
    ['empty', 'This image is empty: nothing is drawn in it.'],
    ['source-too-large', 'This file is too large. Choose one under 25 MB.'],
    ['too-heavy', 'This image has too much detail for a logo. Choose a simpler one.'],
  ] as const)('says why a picture was refused (%s), and takes the next one', async (problem, message) => {
    vi.mocked(prepareLogo).mockRejectedValueOnce(new ImagePipelineError(problem))
    const { user } = setup(BARE)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })

    await user.upload(fileInput('logo'), LOGO_FILE)
    expect(await within(slot('logo')).findByText(message)).toBeInTheDocument()
    expect(preview('logo')).toBeNull()

    // Another file: the message goes, the picture is staged.
    await user.upload(fileInput('logo'), LOGO_FILE)
    await waitFor(() => expect(preview('logo')).not.toBeNull())
    expect(within(slot('logo')).queryByText(message)).toBeNull()
  })

  it('keeps an icon chosen by hand when a new logo is chosen after it, and stages the dark-surface logo on its own', async () => {
    const { user, requests } = setup(BARE)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })

    await user.upload(fileInput('icon'), new File(['icon'], 'mark.png', { type: 'image/png' }))
    await waitFor(() => expect(preview('icon')).toHaveAttribute('src', 'blob:identity/1'))
    expect(slot('icon')).not.toHaveTextContent('Made from the logo')

    await user.upload(fileInput('logo'), LOGO_FILE)
    await waitFor(() => expect(preview('logo')).toHaveAttribute('src', 'blob:identity/2'))
    expect(iconFromLogo).not.toHaveBeenCalled()
    expect(preview('icon')).toHaveAttribute('src', 'blob:identity/1')

    await user.upload(fileInput('logo_dark'), new File(['white'], 'nova-white.svg', { type: 'image/svg+xml' }))
    await waitFor(() => expect(preview('logo_dark')).toHaveAttribute('src', 'blob:identity/3'))

    await user.click(screen.getByRole('button', { name: 'Save identity' }))
    expect(await screen.findByText('Identity saved')).toBeInTheDocument()
    expect(brandRequests(requests)).toEqual([`PUT ${brandPath(BARE)}/assets/logo`, `PUT ${brandPath(BARE)}/assets/icon`, `PUT ${brandPath(BARE)}/assets/logo_dark`])
    expect(await uploaded(requests.filter((request) => request.method === 'PUT')[1])).toBe('png:icon of mark.png')
  })

  it('stops at the file the server refuses, says why under it, and keeps what is still unsaved', async () => {
    const { user, requests } = setup(BARE, {
      [`PUT ${brandPath(BARE)}/assets/icon`]: () =>
        errorResponse(422, 'VALIDATION_ERROR', 'Some fields are invalid.', { fields: { file: 'The image must be square.' }, field_codes: { file: { code: 'image_not_square', params: {} } } }),
    })
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    await user.upload(fileInput('logo'), LOGO_FILE)
    await waitFor(() => expect(preview('icon')).not.toBeNull())
    await user.type(colourField(), ORANGE)

    await user.click(screen.getByRole('button', { name: 'Save identity' }))

    expect(await within(slot('icon')).findByText('The app icon must be square.')).toBeInTheDocument()
    expect(await screen.findByText('The identity could not be saved')).toBeInTheDocument()
    // The logo was saved; the icon and the colour were not, and stay on the page.
    expect(brandRequests(requests)).toEqual([`PUT ${brandPath(BARE)}/assets/logo`, `PUT ${brandPath(BARE)}/assets/icon`])
    await waitFor(() => expect(slot('logo')).not.toHaveTextContent('Not saved yet'))
    expect(slot('icon')).toHaveTextContent('Not saved yet')
    expect(colourField()).toHaveValue(ORANGE)
    expect(status()).toHaveTextContent('You have unsaved changes.')
  })

  it('discards what is staged', async () => {
    const { user, requests } = setup()
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    await user.upload(fileInput('logo'), LOGO_FILE)
    await waitFor(() => expect(slot('logo')).toHaveTextContent('Not saved yet'))
    await user.clear(colourField())
    await user.type(colourField(), ORANGE)

    await user.click(screen.getByRole('button', { name: 'Discard changes' }))

    expect(preview('logo')).toHaveAttribute('src', NOVA.brand.logo_url)
    expect(colourField()).toHaveValue(SAMPLE_COLOURS.teal)
    expect(status()).toHaveTextContent('All changes are saved.')
    expect(brandRequests(requests)).toEqual([])
  })

  it('asks before leaving with unsaved changes', async () => {
    const { user, router } = setup(BARE)
    await screen.findByRole('heading', { level: 1, name: 'Identity' })
    await user.type(colourField(), ORANGE)

    await user.click(screen.getByRole('link', { name: 'Bare Co' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave without saving?' })
    expect(dialog).toHaveTextContent("Your changes to this company's identity have not been saved.")
    await user.click(within(dialog).getByRole('button', { name: 'Stay on this page' }))
    expect(router.state.location.pathname).toBe(`/platform/companies/${BARE.id}/identity`)
  })

  it('is in Arabic for a platform owner who reads Arabic', async () => {
    mockApi({
      ...platformRoutes({ me: makePlatformMe({ preferred_language: 'ar' }), companies: [NOVA] }),
      [`GET /platform/companies/${NOVA.id}`]: () => jsonResponse(NOVA),
    })
    renderRoutes(routes, { initialEntries: [`/platform/companies/${NOVA.id}/identity`] })
    await screen.findByRole('heading', { level: 1, name: 'الهوية' })

    expect(screen.getByRole('link', { name: 'نوفا لابز' })).toBeInTheDocument()
    expect(within(slot('logo')).getByRole('button', { name: 'استبدال: الشعار' })).toHaveTextContent('استبدال')
    expect(within(slot('logo_dark')).getByRole('button', { name: 'اختيار صورة: شعار الخلفيات الداكنة' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'اللون' })).toHaveAttribute('dir', 'ltr')
    expect(screen.getByRole('button', { name: 'استعادة اللون الافتراضي' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'حفظ الهوية' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'نسخ الرابط' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'معاينة هوية نوفا لابز' })).toBeInTheDocument()
    // The link itself reads left to right inside the Arabic page.
    expect(document.querySelector('[data-sign-in-link]')).toHaveAttribute('dir', 'ltr')
    // The company's Arabic name heads the page and is in the tab's title.
    expect(document.querySelector('[data-page-subject]')).toHaveTextContent('نوفا لابز')
    await waitFor(() => expect(document.title).toBe('الهوية · نوفا لابز · زوار موضوع'))
  })

  it('words its refusals in natural Arabic, with the Arabic comma between the formats', async () => {
    const { user } = setupArabic()
    await screen.findByRole('heading', { level: 1, name: 'الهوية' })
    const refuse = async (kind: string, problem: ConstructorParameters<typeof ImagePipelineError>[0], message: string) => {
      vi.mocked(kind === 'icon' ? prepareIcon : prepareLogo).mockRejectedValueOnce(new ImagePipelineError(problem))
      await user.upload(fileInput(kind), LOGO_FILE)
      expect(await within(slot(kind)).findByText(message)).toBeInTheDocument()
    }
    await refuse('logo', 'undecodable', 'تعذّرت قراءة هذا الملف كصورة. اختر ملفًا بإحدى هذه الصيغ: PNG، JPEG، WebP، SVG.')
    await refuse('logo', 'too-light', 'هذا الشعار فاتح جدًا ولن يظهر على خلفية بيضاء. اختر نسخة داكنة هنا، واستخدم هذه النسخة في «شعار الخلفيات الداكنة».')
    await refuse('logo_dark', 'too-dark', 'هذا الشعار داكن جدًا ولن يظهر على خلفية داكنة. اختر نسخة فاتحة هنا، واستخدم هذه النسخة في «الشعار».')
    await refuse('icon', 'too-light', 'هذه الصورة فاتحة جدًا ولن تظهر على خلفية بيضاء. اختر صورة أغمق.')
    await refuse('logo', 'too-wide', 'هذا الشعار عريض جدًا. اختر شعارًا لا يزيد عرضه على 8 أضعاف ارتفاعه.')
    await refuse('logo', 'too-tall', 'هذا الشعار طويل جدًا. اختر شعارًا لا يزيد ارتفاعه على ضعف عرضه.')
    await refuse('logo', 'too-small', 'هذه الصورة صغيرة جدًا. اختر صورة لا يقل طول ضلعها الأطول عن 96 بكسل.')

    // The colour: the form it is written in, with an example.
    await user.clear(screen.getByRole('textbox', { name: 'اللون' }))
    await user.type(screen.getByRole('textbox', { name: 'اللون' }), 'أزرق')
    await user.click(screen.getByRole('button', { name: 'حفظ الهوية' }))
    expect(await screen.findByText('أدخل رمز اللون بهذه الصيغة: #188086.')).toBeInTheDocument()
  })

  it('says in Arabic what goes with a removed picture, and where a made icon came from', async () => {
    wordmark()
    const { user } = setupArabic()
    await screen.findByRole('heading', { level: 1, name: 'الهوية' })

    await user.click(within(slot('logo')).getByRole('button', { name: 'إزالة: الشعار' }))
    let dialog = await screen.findByRole('alertdialog', { name: 'إزالة الشعار؟' })
    expect(dialog).toHaveTextContent('يظهر اسم الشركة مكانه في التطبيق والرسائل وبطاقات الزيارة، وتُزال معه أيقونة التطبيق.')
    await user.click(within(dialog).getByRole('button', { name: 'إلغاء' }))

    await user.click(within(slot('icon')).getByRole('button', { name: 'إزالة: أيقونة التطبيق' }))
    dialog = await screen.findByRole('alertdialog', { name: 'إزالة أيقونة التطبيق؟' })
    expect(dialog).toHaveTextContent('تظهر أيقونة عامة في تبويب المتصفح وفي التطبيق المثبَّت.')
    await user.click(within(dialog).getByRole('button', { name: 'إلغاء' }))

    await user.upload(fileInput('logo'), LOGO_FILE)
    await waitFor(() => expect(slot('icon')).toHaveTextContent('أُنشئت من الاسم'))
    vi.mocked(prepareLogo).mockImplementation((file) => Promise.resolve(prepared(`logo of ${(file as File).name}`, 600, 400)))
    await user.upload(fileInput('logo'), LOGO_FILE)
    await waitFor(() => expect(slot('icon')).toHaveTextContent('أُنشئت من الشعار'))
  })
})

/** The identity page of NOVA for a platform owner who reads Arabic. */
function setupArabic() {
  const withDark = makePlatformCompany({ brand: makeBrand('nova-labs', { color: SAMPLE_COLOURS.teal, logo: true, logoDark: true, icon: true }) })
  mockApi({
    ...platformRoutes({ me: makePlatformMe({ preferred_language: 'ar' }), companies: [withDark] }),
    [`GET /platform/companies/${withDark.id}`]: () => jsonResponse(withDark),
    'POST /platform/brand/palette': (request) => jsonResponse(referencePalette((request.body as { color: string }).color)),
  })
  return renderRoutes(routes, { initialEntries: [`/platform/companies/${withDark.id}/identity`] })
}

describe('a company’s identity elsewhere on the platform', () => {
  it('shows on the company’s page: its logo beside its name, its colour, its sign-in link with a copy button', async () => {
    mockApi({
      ...platformRoutes({ companies: [NOVA] }),
      [`GET /platform/companies/${NOVA.id}`]: () => jsonResponse(NOVA),
      [`GET /platform/companies/${NOVA.id}/admins`]: () => jsonResponse([]),
    })
    renderRoutes(routes, { initialEntries: [`/platform/companies/${NOVA.id}`] })
    const heading = await screen.findByRole('heading', { level: 1, name: 'Nova Labs' })

    // Beside the title, decorative: the name is the heading.
    const tile = heading.closest('header')?.querySelector('[data-company-logo-tile] img')
    expect(tile).toHaveAttribute('src', NOVA.brand.logo_url)
    expect(tile).toHaveAttribute('alt', '')

    const card = screen.getByRole('heading', { level: 2, name: 'Identity' }).closest('section') as HTMLElement
    expect(within(card).getByRole('img', { name: 'Logo of Nova Labs' })).toHaveAttribute('src', NOVA.brand.logo_url)
    expect(card).toHaveTextContent(SAMPLE_COLOURS.teal)
    expect(card.querySelector<HTMLElement>('[data-colour-swatch]')?.style.backgroundColor).toBe('rgb(24, 128, 134)')
    expect(card.querySelector('[data-sign-in-link]')).toHaveTextContent(`${window.location.origin}/c/nova-labs`)
    expect(within(card).getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
    expect(within(card).getByRole('link', { name: 'Edit identity' })).toHaveAttribute('href', `/platform/companies/${NOVA.id}/identity`)
  })

  it('says so for a company without a logo and a colour', async () => {
    mockApi({
      ...platformRoutes({ companies: [BARE] }),
      [`GET /platform/companies/${BARE.id}`]: () => jsonResponse(BARE),
      [`GET /platform/companies/${BARE.id}/admins`]: () => jsonResponse([]),
    })
    renderRoutes(routes, { initialEntries: [`/platform/companies/${BARE.id}`] })
    await screen.findByRole('heading', { level: 1, name: 'Bare Co' })
    const card = screen.getByRole('heading', { level: 2, name: 'Identity' }).closest('section') as HTMLElement
    expect(card).toHaveTextContent('No logo')
    expect(card).toHaveTextContent('Default colour')
    expect(document.querySelector('[data-company-logo-tile]')).toBeNull()
  })

  it('shows each company’s logo in the companies list, and the building tile for one without', async () => {
    mockApi(platformRoutes({ companies: [NOVA, BARE] }))
    renderRoutes(routes, { initialEntries: ['/platform/companies'] })
    const nova = (await screen.findByRole('link', { name: 'Nova Labs' })).closest('tr') as HTMLElement
    expect(nova.querySelector('[data-company-logo-tile] img')).toHaveAttribute('src', NOVA.brand.logo_url)
    const bare = screen.getByRole('link', { name: 'Bare Co' }).closest('tr') as HTMLElement
    expect(bare.querySelector('[data-company-logo-tile]')).toBeNull()
    expect(bare.querySelector('svg')).not.toBeNull()
  })
})

// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { makeBrand, referencePalette, SAMPLE_COLOURS } from '../test/palettes'
import { EMPTY_BRAND, isBrandAssetUrl, isCompanySlug, isLightSurface, paletteProblems, parseBrandPalette, parseCompanyBrand, parsePublicBrand, sameBrand } from './brand'
import { isHexColour, normaliseHexColour } from './colour'

/* What arrives as a company's identity is validated before it is drawn (Phase 12): the session's, the public endpoint's, this device's copy. */

describe('a company’s slug', () => {
  it.each(['acme', 'nova-labs', 'a', 'a1', '9lives', 'x'.repeat(80)])('accepts %s', (slug) => {
    expect(isCompanySlug(slug)).toBe(true)
  })

  it.each(['', 'Acme', '-acme', 'acme-', 'ac me', 'acme/..', 'acme?x', 'شركة', 'x'.repeat(81), null, undefined, 7])('refuses %s', (slug) => {
    expect(isCompanySlug(slug)).toBe(false)
  })
})

describe('the address of a brand file', () => {
  it('is the API’s own public brand file of that company and that kind, with an optional version', () => {
    expect(isBrandAssetUrl('/api/v1/public/companies/acme/brand/logo.png', 'logo', 'acme')).toBe(true)
    expect(isBrandAssetUrl('/api/v1/public/companies/acme/brand/logo.png?v=3f2a9c', 'logo', 'acme')).toBe(true)
    expect(isBrandAssetUrl('/api/v1/public/companies/nova-labs/brand/logo_dark.png?v=2026-10-13T08.00', 'logo_dark', 'nova-labs')).toBe(true)
    expect(isBrandAssetUrl('/api/v1/public/companies/acme/brand/icon.png?v=a_b~c', 'icon', 'acme')).toBe(true)
  })

  it('is refused when it is another company’s file, however valid the address is', () => {
    const theirs = '/api/v1/public/companies/demo-company/brand/logo.png?v=zzz'
    expect(isBrandAssetUrl(theirs, 'logo', 'demo-company')).toBe(true)
    expect(isBrandAssetUrl(theirs, 'logo', 'evil-co')).toBe(false)
    // A slug that only starts or ends like the company's is another company.
    expect(isBrandAssetUrl('/api/v1/public/companies/acme-2/brand/logo.png', 'logo', 'acme')).toBe(false)
    expect(isBrandAssetUrl('/api/v1/public/companies/acme/brand/logo.png', 'logo', 'acme-2')).toBe(false)
    // Without the company's own slug no address can be its own.
    for (const slug of [undefined, null, '', 'Acme Corp', 7]) expect(isBrandAssetUrl('/api/v1/public/companies/acme/brand/logo.png', 'logo', slug)).toBe(false)
  })

  it.each([
    ['another origin', 'https://evil.example/api/v1/public/companies/acme/brand/logo.png'],
    ['a protocol-relative address', '//evil.example/api/v1/public/companies/acme/brand/logo.png'],
    ['a script', 'javascript:alert(1)'],
    ['inline data', 'data:image/png;base64,AAAA'],
    ['another path', '/api/v1/visits'],
    ['a path that leaves the brand folder', '/api/v1/public/companies/acme/brand/../../../auth/me.png'],
    ['another kind’s file', '/api/v1/public/companies/acme/brand/icon.png'],
    ['a slug that is none', '/api/v1/public/companies/Acme Corp/brand/logo.png'],
    ['a second parameter', '/api/v1/public/companies/acme/brand/logo.png?v=1&next=//evil.example'],
    ['another parameter', '/api/v1/public/companies/acme/brand/logo.png?redirect=1'],
    ['a fragment', '/api/v1/public/companies/acme/brand/logo.png#x'],
    ['an over-long address', `/api/v1/public/companies/acme/brand/logo.png?v=${'a'.repeat(500)}`],
    ['no text', 42],
    ['nothing', null],
  ])('refuses %s', (_what, value) => {
    expect(isBrandAssetUrl(value, 'logo', 'acme')).toBe(false)
  })
})

describe('a colour', () => {
  it('is #rrggbb in lower case, as the contract writes it', () => {
    expect(isHexColour('#188086')).toBe(true)
    for (const value of ['#188', '188086', '#18808G', '#18808600', '#188086 ', '#1E3A8A', 'red', null, 0x188086]) expect(isHexColour(value)).toBe(false)
  })

  it('is read from what a person types: three or six digits, with or without the hash, any case', () => {
    expect(normaliseHexColour('#1E3A8A')).toBe('#1e3a8a')
    expect(normaliseHexColour(' f97316 ')).toBe('#f97316')
    expect(normaliseHexColour('#fa0')).toBe('#ffaa00')
    for (const text of ['', '#', '#12', '#12345', '#1234567', 'teal', '#gg0000']) expect(normaliseHexColour(text)).toBeNull()
  })
})

describe('a palette', () => {
  const palette = referencePalette(SAMPLE_COLOURS.darkBlue)

  it('is taken when its colours keep the contract’s guarantees', () => {
    expect(paletteProblems(palette)).toEqual([])
    expect(parseBrandPalette(palette)).toEqual(palette)
    // Extra keys of a newer server are left out, not refused.
    expect(parseBrandPalette({ ...palette, glow: '#ffffff' })).toEqual(palette)
  })

  it('carries what brand surfaces are painted with: the colour itself under whichever ink reads on it', () => {
    // A dark colour: itself, under white.
    expect(palette.surface).toBe(SAMPLE_COLOURS.darkBlue)
    expect(palette.on_surface).toBe('#ffffff')
    expect(isLightSurface(palette)).toBe(false)
    // A yellow: itself, under the dark ink; `strong` stays the darker step for text on white.
    const yellow = referencePalette(SAMPLE_COLOURS.amber)
    expect(parseBrandPalette(yellow)).toEqual(yellow)
    expect(yellow.surface).toBe(SAMPLE_COLOURS.amber)
    expect(yellow.on_surface).toBe(yellow.on_bright)
    expect(yellow.strong).not.toBe(SAMPLE_COLOURS.amber)
    expect(isLightSurface(yellow)).toBe(true)
    // A mid-tone on which neither ink reads: the darkened step, under white.
    const grey = referencePalette(SAMPLE_COLOURS.midGrey)
    expect(grey.surface).toBe(grey.strong)
    expect(isLightSurface(grey)).toBe(false)
  })

  it.each([
    ['the ink would not read on the surface', { surface: '#f5b800' }, 'on_surface on surface'],
    ['the ink would not read on the surface’s hover step', { surface_hover: '#f5b800' }, 'on_surface on surface_hover'],
    ['the surface’s ink is neither white nor the palette’s dark ink', { on_surface: '#fefefe' }, 'on_surface is neither white nor on_bright'],
    ['a light surface is given white ink', { surface: '#f5b800', surface_hover: '#dca400', on_surface: '#ffffff' }, 'on_surface on surface'],
  ])('is refused when %s', (_what, change, problem) => {
    const broken = { ...palette, ...change }
    expect(paletteProblems(broken).join('; ')).toContain(problem)
    expect(parseBrandPalette(broken)).toBeNull()
  })

  it('of an API older than the surface roles, or a copy this device kept from then, is drawn as it was: strong under white', () => {
    const { surface: _surface, on_surface: _onSurface, surface_hover: _surfaceHover, ...older } = referencePalette(SAMPLE_COLOURS.amber)
    const completed = parseBrandPalette(older)
    expect(completed).toEqual({ ...older, surface: older.strong, on_surface: '#ffffff', surface_hover: older.strong_hover })
    expect(paletteProblems(completed!)).toEqual([])
    // Some of the three and not all is no palette: nothing is guessed around a half answer.
    expect(parseBrandPalette({ ...older, surface: '#f5b800' })).toBeNull()
    expect(parseBrandPalette({ ...older, surface: '#f5b800', on_surface: '#1c262b' })).toBeNull()
    expect(parseBrandPalette({ ...older, surface: 'yellow', on_surface: '#1c262b', surface_hover: '#dca400' })).toBeNull()
  })

  it.each([
    ['white text would not read on strong', { strong: '#f7b916' }, 'white on strong'],
    ['white text would not read on the hover step', { strong_hover: '#49cbd2' }, 'white on strong_hover'],
    ['the deep step is not deep', { deep: '#188086' }, 'white on deep'],
    ['the ink does not read on the bright step', { on_bright: '#c3ced5' }, 'on_bright on bright'],
    ['the bright step does not stand off the deep one', { bright: '#33444e' }, 'bright on deep'],
    ['strong does not read on the tint', { tint: '#188086' }, 'strong on tint'],
    ['the text on strong is not white enough', { on_strong: '#33444e' }, 'on_strong on strong'],
  ])('is refused when %s', (_what, change, problem) => {
    const broken = { ...palette, ...change }
    expect(paletteProblems(broken).join('; ')).toContain(problem)
    expect(parseBrandPalette(broken)).toBeNull()
  })

  it('is refused when a role is the wrong way round, whatever its ratio', () => {
    // A "tint" darker than strong with enough contrast: text in strong would be light on dark.
    expect(parseBrandPalette({ ...referencePalette('#8a8a8a'), tint: '#000000' })).toBeNull()
    // "Ink" lighter than the bright step.
    expect(parseBrandPalette({ ...palette, bright: '#33444e', on_bright: '#ffffff' })).toBeNull()
  })

  it.each([
    ['a colour is missing', { strong: undefined }],
    ['a colour is no colour', { strong: 'teal' }],
    ['a colour is in upper case', { strong: '#1E3A8A' }],
    ['a colour carries a style', { strong: '#1e3a8a; background: url(//evil.example)' }],
  ])('is refused when %s', (_what, change) => {
    expect(parseBrandPalette({ ...palette, ...change })).toBeNull()
  })

  it.each([null, undefined, 'palette', 7, []])('is refused when it is %s', (value) => {
    expect(parseBrandPalette(value)).toBeNull()
  })
})

describe('a company’s brand', () => {
  it('is kept as it is when everything in it is valid', () => {
    const brand = makeBrand('acme', { color: SAMPLE_COLOURS.orange, logo: true, logoDark: true, icon: true, version: '3f2a' })
    expect(parseCompanyBrand(brand, 'acme')).toEqual(brand)
  })

  it('is the empty brand for a session without one (an older API, a mocked session)', () => {
    for (const value of [undefined, null, 'brand', 3]) expect(parseCompanyBrand(value, 'acme')).toEqual(EMPTY_BRAND)
    expect(EMPTY_BRAND).toEqual({ logo_url: null, logo_dark_url: null, icon_url: null, color: null, palette: null, version: '' })
  })

  it('leaves out each part that is not valid, and keeps the rest', () => {
    const brand = makeBrand('acme', { color: SAMPLE_COLOURS.red, logo: true, logoDark: true, icon: true })
    expect(parseCompanyBrand({ ...brand, logo_dark_url: 'https://evil.example/x.png' }, 'acme')).toEqual({ ...brand, logo_dark_url: null })
    // A logo's address in the icon's place is not the icon.
    expect(parseCompanyBrand({ ...brand, icon_url: brand.logo_url }, 'acme')).toEqual({ ...brand, icon_url: null })
    expect(parseCompanyBrand({ ...brand, version: 7 }, 'acme').version).toBe('')
  })

  it('never shows another company’s files: each address must be this company’s own (security review, Phase 12)', () => {
    const theirs = makeBrand('demo-company', { color: SAMPLE_COLOURS.teal, logo: true, logoDark: true, icon: true })
    // The whole brand of another company under this one's slug: its files are left out, its colours are only colours.
    expect(parseCompanyBrand(theirs, 'evil-co')).toEqual({ ...theirs, logo_url: null, logo_dark_url: null, icon_url: null })
    // One foreign address among the company's own.
    const own = makeBrand('evil-co', { logo: true, logoDark: true, icon: true })
    expect(parseCompanyBrand({ ...own, logo_url: theirs.logo_url }, 'evil-co')).toEqual({ ...own, logo_url: null })
    expect(parseCompanyBrand({ ...own, icon_url: theirs.icon_url }, 'evil-co')).toEqual({ ...own, icon_url: null })
    // A brand whose company is not known has no files.
    for (const slug of [undefined, null, '', 'Not A Slug']) expect(parseCompanyBrand(own, slug)).toEqual({ ...own, logo_url: null, logo_dark_url: null, icon_url: null })
  })

  it('has a colour and a palette together or neither', () => {
    const brand = makeBrand('acme', { color: SAMPLE_COLOURS.red, logo: true })
    // A colour whose palette would not read: the default palette, the logo kept.
    expect(parseCompanyBrand({ ...brand, palette: { ...brand.palette, strong: '#ffffff' } }, 'acme')).toEqual({ ...brand, color: null, palette: null })
    expect(parseCompanyBrand({ ...brand, palette: null }, 'acme')).toEqual({ ...brand, color: null, palette: null })
    expect(parseCompanyBrand({ ...brand, color: null }, 'acme')).toEqual({ ...brand, color: null, palette: null })
    expect(parseCompanyBrand({ ...brand, color: 'red' }, 'acme')).toEqual({ ...brand, color: null, palette: null })
  })

  it('is compared by what it draws', () => {
    const brand = makeBrand('acme', { color: SAMPLE_COLOURS.red, logo: true })
    expect(sameBrand(brand, structuredClone(brand))).toBe(true)
    expect(sameBrand(brand, { ...brand, version: 'v2' })).toBe(false)
    expect(sameBrand(brand, makeBrand('acme', { color: SAMPLE_COLOURS.teal, logo: true }))).toBe(false)
  })
})

describe('a company’s public brand', () => {
  const answer = { slug: 'acme', name: 'Acme Holdings', name_ar: 'أكمي القابضة', default_language: 'en', brand: makeBrand('acme', { color: SAMPLE_COLOURS.teal, logo: true }) }

  it('is taken with its names, its language and its validated brand', () => {
    expect(parsePublicBrand(answer)).toEqual(answer)
    expect(parsePublicBrand({ ...answer, name_ar: null })?.name_ar).toBeNull()
    expect(parsePublicBrand({ ...answer, name_ar: '   ' })?.name_ar).toBeNull()
    expect(parsePublicBrand({ ...answer, default_language: 'fr' })?.default_language).toBe('ar')
    expect(parsePublicBrand({ ...answer, brand: undefined })?.brand).toEqual(EMPTY_BRAND)
    expect(parsePublicBrand({ ...answer, name: '  Acme  ' })?.name).toBe('Acme')
  })

  it('keeps only the files of the company it names: an answer or a stored copy cannot borrow another company’s logo', () => {
    const theirs = makeBrand('demo-company', { color: SAMPLE_COLOURS.teal, logo: true, logoDark: true, icon: true })
    const forged = parsePublicBrand({ slug: 'evil-co', name: 'Evil Co', name_ar: null, default_language: 'en', brand: { ...theirs, logo_url: '/api/v1/public/companies/demo-company/brand/logo.png?v=zzz' } })
    expect(forged?.brand).toEqual({ ...theirs, logo_url: null, logo_dark_url: null, icon_url: null })
    // The same brand under its own company's slug is whole.
    expect(parsePublicBrand({ ...answer, slug: 'demo-company', brand: theirs })?.brand).toEqual(theirs)
  })

  it.each([
    ['its slug is none', { slug: 'Acme Corp' }],
    ['it has no name', { name: '' }],
    ['its name is no text', { name: 12 }],
    ['its name holds a control character', { name: 'Acme\u0007' }],
    ['its name is over-long', { name: 'A'.repeat(201) }],
  ])('is refused when %s', (_what, change) => {
    expect(parsePublicBrand({ ...answer, ...change })).toBeNull()
  })

  it.each([null, undefined, 'acme', []])('is refused when it is %s', (value) => {
    expect(parsePublicBrand(value)).toBeNull()
  })
})

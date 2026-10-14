import { describe, expect, it } from 'vitest'
import { ImagePipelineError, NEUTRAL_TILE } from '../../identity/imagePipeline'
import { applyLanguage } from '../../i18n'
import { referencePalette, SAMPLE_COLOURS } from '../../test/palettes'
import { darkSurfaceOf, iconLetter, imageFormats, letterTileOf, originOf, preparationProblem, sameTile, type AssetDraft } from './identityForm'

/* The identity page's own rules (Phase 12): the icon's letter and tile, the dark-surface logo's ground, the words of a refusal. */

describe('the letter of a company’s icon', () => {
  it('is the first letter of the name its people read first, in that name’s script', () => {
    expect(iconLetter({ name: 'Sahara Sun Hotels', name_ar: 'فنادق شمس الصحراء', default_language: 'en' })).toBe('S')
    expect(iconLetter({ name: 'Sahara Sun Hotels', name_ar: 'فنادق شمس الصحراء', default_language: 'ar' })).toBe('ف')
    // A company without an Arabic name has its one name's letter, whatever its language.
    expect(iconLetter({ name: 'Atlas Bank', name_ar: null, default_language: 'ar' })).toBe('A')
    expect(iconLetter({ name: 'nova labs', name_ar: null, default_language: 'en' })).toBe('N')
  })

  it('skips the Arabic article and what is no letter: «البنك العربي» is «ب», "3M" is 3', () => {
    expect(iconLetter({ name: 'Arab Bank', name_ar: 'البنك العربي', default_language: 'ar' })).toBe('ب')
    expect(iconLetter({ name: '3M Gulf', name_ar: null, default_language: 'en' })).toBe('3')
    expect(iconLetter({ name: '“Élan” & Co', name_ar: null, default_language: 'en' })).toBe('É')
    expect(iconLetter({ name: '& — Partners', name_ar: null, default_language: 'en' })).toBe('P')
    // A name that is an English one written where the Arabic one belongs still gives a letter.
    expect(iconLetter({ name: '***', name_ar: 'نبض', default_language: 'en' })).toBe('ن')
    expect(iconLetter({ name: '***', name_ar: null, default_language: 'en' })).toBe('')
  })
})

describe('a company’s letter tile', () => {
  it('is its surface colour under that surface’s ink, and the neutral tile without a colour', () => {
    const yellow = referencePalette(SAMPLE_COLOURS.amber)
    expect(letterTileOf('S', yellow)).toEqual({ letter: 'S', background: SAMPLE_COLOURS.amber, ink: yellow.on_surface })
    const blue = referencePalette(SAMPLE_COLOURS.darkBlue)
    expect(letterTileOf('N', blue)).toEqual({ letter: 'N', background: SAMPLE_COLOURS.darkBlue, ink: '#ffffff' })
    expect(letterTileOf('N', null)).toEqual({ letter: 'N', ...NEUTRAL_TILE })
  })

  it('is compared by what is drawn', () => {
    const tile = letterTileOf('S', referencePalette(SAMPLE_COLOURS.amber))
    expect(sameTile(tile, { ...tile })).toBe(true)
    expect(sameTile(tile, { ...tile, letter: 'T' })).toBe(false)
    expect(sameTile(tile, letterTileOf('S', referencePalette(SAMPLE_COLOURS.orange)))).toBe(false)
  })

  it('knows where a saved icon came from only for this visit: made by the page, or chosen by hand', () => {
    const draft: AssetDraft = { blob: new Blob(['png']), url: 'blob:1', width: 512, height: 512, generated: true }
    const tile = letterTileOf('S', null)
    expect(originOf(draft)).toEqual({ by: 'page', tile: null })
    expect(originOf({ ...draft, tile })).toEqual({ by: 'page', tile })
    expect(originOf({ ...draft, generated: false })).toEqual({ by: 'hand' })
  })
})

describe('the ground of the logo for dark surfaces', () => {
  it('is the company’s shell where that is dark, its deep step where the shell is a light colour, and the default teal without a colour', () => {
    const blue = referencePalette(SAMPLE_COLOURS.darkBlue)
    expect(darkSurfaceOf(blue)).toBe(blue.surface)
    const yellow = referencePalette(SAMPLE_COLOURS.amber)
    expect(darkSurfaceOf(yellow)).toBe(yellow.deep)
    expect(darkSurfaceOf(null)).toBe('#188086')
  })
})

describe('what the page says about a refused picture', () => {
  it('lists the formats with the language’s own comma', () => {
    expect(imageFormats('en')).toBe('PNG, JPEG, WebP, SVG')
    expect(imageFormats('ar')).toBe('PNG، JPEG، WebP، SVG')
    applyLanguage('ar')
    expect(preparationProblem(new ImagePipelineError('undecodable'))).toBe('تعذّرت قراءة هذا الملف كصورة. اختر ملفًا بإحدى هذه الصيغ: PNG، JPEG، WebP، SVG.')
    applyLanguage('en')
    expect(preparationProblem(new ImagePipelineError('undecodable'))).toBe('This file cannot be read as an image. Choose a PNG, JPEG, WebP, SVG file.')
  })

  it('names the place a logo belongs in when it would not show in the one it was chosen for', () => {
    expect(preparationProblem(new ImagePipelineError('too-light'), 'logo')).toContain('use this one as the “Logo for dark surfaces”')
    expect(preparationProblem(new ImagePipelineError('too-dark'), 'logo_dark')).toContain('use this one as the “Logo”')
    // An icon has no other place: it is asked for a darker picture.
    expect(preparationProblem(new ImagePipelineError('too-light'), 'icon')).toBe('This image is too light to show on a white background. Choose a darker one.')
  })

  it('gives the limits as the pipeline has them, and takes anything else for a file that is no picture', () => {
    expect(preparationProblem(new ImagePipelineError('too-wide'))).toContain('at most 8 times as wide')
    expect(preparationProblem(new ImagePipelineError('too-small'))).toContain('at least 96 pixels')
    expect(preparationProblem(new ImagePipelineError('source-too-large'))).toContain('under 25 MB')
    expect(preparationProblem(new Error('the canvas failed'))).toBe('This file cannot be read as an image. Choose a PNG, JPEG, WebP, SVG file.')
  })
})

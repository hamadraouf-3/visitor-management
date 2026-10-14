import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { chooseAppearance } from '../../appearance/appearance'
import { EMPTY_BRAND } from '../../identity/brand'
import { makeBrand } from '../../test/palettes'
import { CompanyLogo, EMBLEM_MAX_RATIO } from './CompanyLogo'

/* A company's logo where it stands (Phase 12): the right file for the surface, a plate where the logo needs one, its name without a logo. */

const BOTH = makeBrand('nova-labs', { logo: true, logoDark: true })
const LIGHT_ONLY = makeBrand('nova-labs', { logo: true })
const DARK_ONLY = { ...makeBrand('nova-labs', { logoDark: true }) }

/** The device chooses its appearance (Phase 13): the scheme a logo is chosen by. */
const choose = (appearance: Parameters<typeof chooseAppearance>[0]) => act(() => chooseAppearance(appearance))

/** The browser has the file: its size is known, and the image says so (jsdom loads none). */
function load(image: HTMLElement, width: number, height: number) {
  Object.defineProperty(image, 'naturalWidth', { value: width, configurable: true })
  Object.defineProperty(image, 'naturalHeight', { value: height, configurable: true })
  Object.defineProperty(image, 'complete', { value: true, configurable: true })
  fireEvent.load(image)
}

/** The file the browser chose for the image does not load: the error is about that file (jsdom chooses none). */
function failing(url: string) {
  const image = screen.getByRole('img', { name: 'Nova Labs' })
  Object.defineProperty(image, 'currentSrc', { value: new URL(url, document.baseURI).href, configurable: true })
  fireEvent.error(image)
}

describe('CompanyLogo', () => {
  describe('on the shell', () => {
    it('shows the logo for dark surfaces on the shell itself, named by the company', () => {
      const { container } = render(<CompanyLogo brand={BOTH} name="Nova Labs" surface="shell" />)
      const logo = screen.getByRole('img', { name: 'Nova Labs' })
      expect(logo).toHaveAttribute('src', BOTH.logo_dark_url)
      expect(logo).toHaveAttribute('data-company-logo', 'dark')
      expect(container.querySelector('[data-logo-plate]')).toBeNull()
    })

    it('puts the only logo, made for light surfaces, on a white plate', () => {
      const { container } = render(<CompanyLogo brand={LIGHT_ONLY} name="Nova Labs" surface="shell" size="sm" />)
      const logo = screen.getByRole('img', { name: 'Nova Labs' })
      expect(logo).toHaveAttribute('src', LIGHT_ONLY.logo_url)
      expect(logo).toHaveAttribute('data-company-logo', 'light')
      const plate = container.querySelector('[data-logo-plate]')
      expect(plate).toHaveClass('bg-white')
      expect(plate).toContainElement(logo)
    })

    it('is the company’s name as a wordmark without a logo: never another logo', () => {
      const { container } = render(<CompanyLogo brand={EMPTY_BRAND} name="Other Corp" surface="shell" />)
      expect(container.querySelector('img')).toBeNull()
      const wordmark = screen.getByText('Other Corp')
      expect(wordmark).toHaveAttribute('data-company-wordmark')
      expect(wordmark).toHaveClass('font-display', 'text-fg')
      // An Arabic name in an English page, or the reverse, takes its own direction.
      expect(wordmark).toHaveAttribute('dir', 'auto')
    })
  })

  describe('on a shell that is a light colour (a yellow, a pastel: dark ink)', () => {
    it('never draws the logo for dark surfaces on it: the logo for light surfaces, on its plate', () => {
      // A white logo on a yellow shell would not show; and a logo drawn on its own colour would disappear, so the plate stays.
      const { container } = render(<CompanyLogo brand={BOTH} name="Nova Labs" surface="shell" shellTone="light" />)
      const logo = screen.getByRole('img', { name: 'Nova Labs' })
      expect(logo).toHaveAttribute('src', BOTH.logo_url)
      expect(logo).toHaveAttribute('data-company-logo', 'light')
      const plate = container.querySelector('[data-logo-plate]')
      expect(plate).toHaveClass('bg-white')
      expect(plate).toContainElement(logo)
    })

    it('takes the logo for dark surfaces in the dark colour scheme alone, where the shell is the deep one, and lets go of the plate there', () => {
      const { container } = render(<CompanyLogo brand={BOTH} name="Nova Labs" surface="shell" shellTone="light" />)
      // The light scheme: the logo for light surfaces, nothing else offered.
      expect(container.querySelector('picture source')).toBeNull()
      choose('dark')
      const source = container.querySelector('picture source')
      expect(source).toHaveAttribute('srcset', BOTH.logo_dark_url)
      // On screen only: paper is light.
      expect(source).toHaveAttribute('media', 'screen')
      expect(container.querySelector('[data-logo-plate="light-scheme"]')).toHaveClass('bg-white', 'scheme-dark:bg-transparent')
    })

    it('keeps the plate in both schemes for a company with one logo, and the name for one with none', () => {
      const { container, rerender } = render(<CompanyLogo brand={LIGHT_ONLY} name="Nova Labs" surface="shell" shellTone="light" />)
      expect(container.querySelector('picture')).toBeNull()
      expect(container.querySelector('[data-logo-plate]')).toHaveClass('bg-white')
      expect(container.querySelector('[data-logo-plate]')).not.toHaveClass('scheme-dark:bg-transparent')
      // The name takes the shell's ink through the token, dark on a light shell.
      rerender(<CompanyLogo brand={EMPTY_BRAND} name="Nova Labs" surface="shell" shellTone="light" />)
      expect(screen.getByText('Nova Labs')).toHaveClass('text-fg')
      // A company with a logo for dark surfaces alone has nothing to show on a light one: its name.
      rerender(<CompanyLogo brand={DARK_ONLY} name="Nova Labs" surface="shell" shellTone="light" />)
      expect(container.querySelector('img')).toBeNull()
      expect(screen.getByText('Nova Labs')).toHaveAttribute('data-company-wordmark')
    })
  })

  describe('on a page', () => {
    it('stands on a white plate with the cards’ edge, so a logo with a background of its own looks meant', () => {
      const { container } = render(<CompanyLogo brand={LIGHT_ONLY} name="Nova Labs" surface="page" size="lg" />)
      const plate = container.querySelector('[data-logo-plate]')
      expect(plate).toHaveClass('bg-white', 'border', 'border-border')
      expect(plate).toContainElement(screen.getByRole('img', { name: 'Nova Labs' }))
      // One logo: the plate carries it in the dark scheme too.
      expect(plate).not.toHaveClass('scheme-dark:bg-transparent')
      expect(container.querySelector('picture')).toBeNull()
    })

    it('takes the dark-surface logo in the dark scheme, without the plate there', () => {
      choose('dark')
      const { container } = render(<CompanyLogo brand={BOTH} name="Nova Labs" surface="page" size="lg" />)
      expect(screen.getByRole('img', { name: 'Nova Labs' })).toHaveAttribute('src', BOTH.logo_url)
      const source = container.querySelector('picture source')
      expect(source).toHaveAttribute('srcset', BOTH.logo_dark_url)
      // On screen only: paper is light.
      expect(source).toHaveAttribute('media', 'screen')
      expect(container.querySelector('[data-logo-plate="light-scheme"]')).toHaveClass('bg-white', 'scheme-dark:bg-transparent', 'scheme-dark:border-transparent')
    })

    it('follows the device’s choice, not the device’s own scheme, and a change of it at once (Phase 13)', () => {
      // A device in its dark scheme whose person chose Light: the logo for light surfaces.
      vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(prefers-color-scheme: dark)', media: query, addEventListener: () => {}, removeEventListener: () => {} }))
      choose('light')
      const { container } = render(<CompanyLogo brand={BOTH} name="Nova Labs" surface="page" size="lg" />)
      expect(container.querySelector('picture source')).toBeNull()
      // System: the device's own scheme, dark here.
      choose('system')
      expect(container.querySelector('picture source')).toHaveAttribute('srcset', BOTH.logo_dark_url)
      choose('light')
      expect(container.querySelector('picture source')).toBeNull()
    })

    it('is the company’s name, centred, without a logo for light surfaces', () => {
      render(<CompanyLogo brand={DARK_ONLY} name="Nova Labs" surface="page" size="lg" />)
      expect(screen.queryByRole('img')).toBeNull()
      expect(screen.getByText('Nova Labs')).toHaveClass('text-center')
    })
  })

  describe('on paper', () => {
    it('is the logo for light surfaces, whatever the screen’s scheme, or the name in black', () => {
      const { container, rerender } = render(<CompanyLogo brand={BOTH} name="Nova Labs" surface="paper" />)
      expect(screen.getByRole('img', { name: 'Nova Labs' })).toHaveAttribute('src', BOTH.logo_url)
      expect(container.querySelector('source, [data-logo-plate]')).toBeNull()

      rerender(<CompanyLogo brand={EMPTY_BRAND} name="Nova Labs" surface="paper" />)
      expect(screen.getByText('Nova Labs')).toHaveClass('text-black')
    })

    it('is decoded with the frame it is drawn in: a sheet is printed once, and the logo must be on it', () => {
      const { rerender } = render(<CompanyLogo brand={BOTH} name="Nova Labs" surface="paper" />)
      expect(screen.getByRole('img', { name: 'Nova Labs' })).toHaveAttribute('decoding', 'sync')
      // On screen a logo may arrive a frame later rather than hold the page.
      rerender(<CompanyLogo brand={BOTH} name="Nova Labs" surface="shell" />)
      expect(screen.getByRole('img', { name: 'Nova Labs' })).toHaveAttribute('decoding', 'async')
    })
  })

  describe('an emblem (a logo about as wide as tall), which does not say whose it is', () => {
    it.each(['shell', 'page', 'paper'] as const)('has the company’s name written beside it: %s', (surface) => {
      const { container } = render(<CompanyLogo brand={LIGHT_ONLY} name="Nova Labs" surface={surface} />)
      // Until the file is there, its shape is not known: the logo alone, named by the company.
      expect(container.querySelector('[data-company-name]')).toBeNull()
      const image = screen.getByRole('img', { name: 'Nova Labs' })
      load(image, 512, 512)
      const name = container.querySelector('[data-company-name]')
      expect(name).toHaveTextContent('Nova Labs')
      expect(name).toHaveAttribute('dir', 'auto')
      expect(name).toHaveClass(surface === 'paper' ? 'text-black' : 'text-fg')
      // The name is read once: beside its written form the picture has no text alternative.
      expect(image).toHaveAttribute('alt', '')
      expect(screen.queryByRole('img', { name: 'Nova Labs' })).toBeNull()
      expect(container.querySelector('[data-logo-with-name]')).toContainElement(image)
    })

    it('is told from a wordmark by its proportions: the name is not repeated beside a logo that is wider', () => {
      const { container } = render(<CompanyLogo brand={LIGHT_ONLY} name="Nova Labs" surface="page" />)
      const image = screen.getByRole('img', { name: 'Nova Labs' })
      load(image, 900, 240)
      expect(container.querySelector('[data-company-name]')).toBeNull()
      expect(image).toHaveAttribute('alt', 'Nova Labs')
      // Up to the limit a logo is an emblem (a tall one too); just past it, a wordmark.
      load(image, Math.round(100 * EMBLEM_MAX_RATIO), 100)
      expect(container.querySelector('[data-company-name]')).toHaveTextContent('Nova Labs')
      load(image, Math.round(100 * EMBLEM_MAX_RATIO) + 2, 100)
      expect(container.querySelector('[data-company-name]')).toBeNull()
      load(image, 120, 300)
      expect(container.querySelector('[data-company-name]')).toHaveTextContent('Nova Labs')
    })

    it('is left alone where the name already stands next to it (a printed sheet’s header)', () => {
      const { container } = render(<CompanyLogo brand={LIGHT_ONLY} name="Nova Labs" surface="paper" nameBeside={false} />)
      load(screen.getByRole('img', { name: 'Nova Labs' }), 512, 512)
      expect(container.querySelector('[data-company-name]')).toBeNull()
      expect(screen.getByRole('img', { name: 'Nova Labs' })).toBeInTheDocument()
    })

    it('measures a new logo anew: the name does not stay beside a wordmark that replaced an emblem', () => {
      const { container, rerender } = render(<CompanyLogo brand={LIGHT_ONLY} name="Nova Labs" surface="shell" />)
      const image = container.querySelector('img')!
      load(image, 300, 300)
      expect(container.querySelector('[data-company-name]')).not.toBeNull()
      // Another file is on its way: until it has loaded the image is not complete, as in a browser.
      Object.defineProperty(image, 'complete', { value: false, configurable: true })
      const next = makeBrand('nova-labs', { logo: true, version: 'v2' })
      rerender(<CompanyLogo brand={next} name="Nova Labs" surface="shell" />)
      expect(container.querySelector('[data-company-name]')).toBeNull()
      expect(screen.getByRole('img', { name: 'Nova Labs' })).toHaveAttribute('src', next.logo_url)
      load(image, 900, 240)
      expect(container.querySelector('[data-company-name]')).toBeNull()
    })
  })

  it('falls back to the name when the logo’s file does not load, and tries a new file again', () => {
    const { rerender } = render(<CompanyLogo brand={LIGHT_ONLY} name="Nova Labs" surface="shell" />)
    fireEvent.error(screen.getByRole('img', { name: 'Nova Labs' }))
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('Nova Labs')).toHaveAttribute('data-company-wordmark')

    // A new logo is uploaded: its address is another, and it is shown.
    const next = makeBrand('nova-labs', { logo: true, version: 'v2' })
    rerender(<CompanyLogo brand={next} name="Nova Labs" surface="shell" />)
    expect(screen.getByRole('img', { name: 'Nova Labs' })).toHaveAttribute('src', next.logo_url)
  })

  it('gives up only the file that failed: a logo for dark surfaces that does not load leaves the one for light surfaces, on its plate', () => {
    choose('dark')
    const { container } = render(<CompanyLogo brand={BOTH} name="Nova Labs" surface="page" size="lg" />)
    failing(BOTH.logo_dark_url!)
    expect(screen.getByRole('img', { name: 'Nova Labs' })).toHaveAttribute('src', BOTH.logo_url)
    expect(container.querySelector('picture')).toBeNull()
    // The light logo stands on its white plate in the dark scheme too, as a company's only logo does.
    expect(container.querySelector('[data-logo-plate]')).toHaveClass('bg-white')
    expect(container.querySelector('[data-logo-plate]')).not.toHaveClass('scheme-dark:bg-transparent')
    expect(container.querySelector('[data-company-wordmark]')).toBeNull()

    // That one failing too: the name.
    failing(BOTH.logo_url!)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('Nova Labs')).toHaveAttribute('data-company-wordmark')
  })

  it('has no text alternative where the name is said beside it', () => {
    const { container } = render(<CompanyLogo brand={LIGHT_ONLY} name="Nova Labs" surface="shell" decorative />)
    expect(container.querySelector('img')).toHaveAttribute('alt', '')
    expect(screen.queryByRole('img', { name: 'Nova Labs' })).toBeNull()
  })

  it('is phrasing content only, so it can be a heading’s text', () => {
    for (const brand of [BOTH, LIGHT_ONLY, EMPTY_BRAND]) {
      for (const surface of ['shell', 'page', 'paper'] as const) {
        for (const shellTone of ['dark', 'light'] as const) {
          const { container, unmount } = render(
            <h2>
              <CompanyLogo brand={brand} name="Nova Labs" surface={surface} shellTone={shellTone} />
            </h2>,
          )
          const image = container.querySelector('img')
          if (image) load(image, 256, 256)
          expect(container.querySelectorAll('h2 div, h2 p')).toHaveLength(0)
          unmount()
        }
      }
    }
  })
})

import { act, fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { chooseAppearance } from '../../appearance/appearance'
import { makeBrand } from '../../test/palettes'
import { CompanyLogoTile } from './CompanyLogoTile'

/* A company's logo on the platform owner's pages (Phase 12): on the card itself in the light scheme, a plate only where the logo needs one (F13-26). */

const company = (files: { logo?: boolean; logoDark?: boolean }) => ({ slug: 'nova-labs', is_active: true, brand: makeBrand('nova-labs', files) })
const tile = (container: HTMLElement) => container.querySelector('[data-company-logo-tile]')
/** A box's classes but those of the dark scheme. */
const withoutDarkScheme = (classes: string) => classes.split(' ').filter((name) => !name.startsWith('scheme-dark:'))

describe('CompanyLogoTile', () => {
  it('stands the logo on the card in the light scheme: no fill, no edge', () => {
    const nova = company({ logo: true, logoDark: true })
    const { container } = render(<CompanyLogoTile company={nova} size="lg" />)
    expect(container.querySelector('img')).toHaveAttribute('src', nova.brand.logo_url)
    expect(tile(container)).toHaveClass('border-transparent')
    expect(tile(container)).not.toHaveClass('bg-white')
    expect(tile(container)).toHaveAttribute('data-logo-plate', 'dark-scheme')
  })

  it('takes the logo for dark surfaces in the dark scheme, without a plate, in the same box', () => {
    const nova = company({ logo: true, logoDark: true })
    const { container } = render(<CompanyLogoTile company={nova} size="lg" />)
    const box = tile(container)!.className
    act(() => chooseAppearance('dark'))
    expect(container.querySelector('img')).toHaveAttribute('src', nova.brand.logo_dark_url)
    expect(tile(container)).not.toHaveAttribute('data-logo-plate')
    expect(tile(container)).not.toHaveClass('scheme-dark:bg-white')
    // The plate's classes aside, the box is the one of the light scheme.
    expect(withoutDarkScheme(tile(container)!.className)).toEqual(withoutDarkScheme(box))
    // The file does not load: the logo for light surfaces, on its plate.
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toHaveAttribute('src', nova.brand.logo_url)
    expect(tile(container)).toHaveClass('scheme-dark:bg-white', 'scheme-dark:border-border')
  })

  it('puts a company’s only logo on a white plate in the dark scheme', () => {
    act(() => chooseAppearance('dark'))
    const { container } = render(<CompanyLogoTile company={company({ logo: true })} />)
    expect(tile(container)).toHaveAttribute('data-logo-plate', 'dark-scheme')
    expect(tile(container)).toHaveClass('scheme-dark:bg-white', 'scheme-dark:border-border')
  })

  it('is the building tile without a logo, or when its file does not load', () => {
    const { container, rerender } = render(<CompanyLogoTile company={company({})} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
    rerender(<CompanyLogoTile company={company({ logo: true })} />)
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })
})

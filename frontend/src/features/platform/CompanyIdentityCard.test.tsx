import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { makeBrand } from '../../test/palettes'
import { renderWithProviders } from '../../test/render'
import { CompanyIdentityCard } from './CompanyIdentityCard'
import { makePlatformCompany } from './testRoutes'

/* A company's logo on its page (Phase 12): on the card itself in the light scheme, on a white plate in the dark scheme only (F13-26). */

describe('CompanyIdentityCard', () => {
  it('stands the logo on the card in the light scheme, and on a white plate in the dark scheme only', () => {
    const nova = makePlatformCompany({ brand: makeBrand('nova-labs', { logo: true }) })
    renderWithProviders(<CompanyIdentityCard company={nova} displayName="Nova Labs" />)

    const plate = screen.getByRole('img').closest('[data-logo-plate]')
    expect(plate).toHaveAttribute('data-logo-plate', 'dark-scheme')
    // The dark scheme's plate: white, with an edge.
    expect(plate).toHaveClass('scheme-dark:bg-white', 'scheme-dark:border-border')
    // None in the light scheme: no fill, no visible edge.
    expect(plate).toHaveClass('border-transparent')
    expect(plate).not.toHaveClass('bg-white')
    expect(plate).not.toHaveClass('border-border')
  })
})

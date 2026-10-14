import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { chooseAppearance } from '../../appearance/appearance'
import { productName } from '../../brand'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { i18n } from '../../i18n'
import { useProductName } from '../../i18n/useLanguage'
import { renderRoutes } from '../../test/render'
import { BrandLockup } from './BrandLockup'
import { BrandLogo } from './BrandLogo'

/* The product's own name and logo: the platform owner's area's alone since Phase 12. */

/** An element on a page of the platform owner's area, or wherever `path` says. */
function at(path: string, element: ReactElement) {
  return render(<MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>)
}

function Title({ title }: { title: string }) {
  useDocumentTitle(title)
  return null
}

describe('the product name (brand pass, decision 1)', () => {
  it('is «زوار موضوع» in Arabic and "Mawdoo3 Visitors" in English, never "Visitor Management"', () => {
    expect(productName('ar')).toBe('زوار موضوع')
    expect(productName('en')).toBe('Mawdoo3 Visitors')
  })

  it('follows a language switch', async () => {
    const { result } = renderHook(() => useProductName())
    expect(result.current).toBe('Mawdoo3 Visitors')
    await act(() => i18n.changeLanguage('ar'))
    expect(result.current).toBe('زوار موضوع')
  })

  it('ends the document titles of the platform owner’s area, in the UI language', async () => {
    renderRoutes([{ path: '*', element: <Title title="Companies" /> }], { initialEntries: ['/platform/companies'] })
    await waitFor(() => expect(document.title).toBe('Companies · Mawdoo3 Visitors'))
    await act(() => i18n.changeLanguage('ar'))
    await waitFor(() => expect(document.title).toBe('Companies · زوار موضوع'))
  })

  it('ends no title outside it: a neutral page’s title is the page alone', async () => {
    renderRoutes([{ path: '*', element: <Title title="Sign in" /> }], { initialEntries: ['/login'] })
    await waitFor(() => expect(document.title).toBe('Sign in'))
    await act(() => i18n.changeLanguage('ar'))
    await waitFor(() => expect(document.title).toBe('Sign in'))
  })
})

describe('BrandLockup, in the platform owner’s area', () => {
  it('on a page: the teal logo (white in the dark scheme), decorative, over the product name', () => {
    const { container } = at('/platform/login', <BrandLockup surface="page" size="lg" />)
    const lockup = container.querySelector('[data-brand-lockup="page"]')
    expect(lockup).toHaveTextContent('Mawdoo3 Visitors')
    const image = lockup?.querySelector('img')
    expect(image).toHaveAttribute('src', '/brand/logo-teal.png')
    expect(image).toHaveAttribute('alt', '')
    // The white file in the dark colour scheme of the device's appearance only (Phase 13), on screen.
    expect(lockup?.querySelector('source')).toBeNull()
    act(() => chooseAppearance('dark'))
    expect(lockup?.querySelector('source')).toHaveAttribute('srcset', '/brand/logo-white.png')
    expect(lockup?.querySelector('source')).toHaveAttribute('media', 'screen')
    // Read once, as the product's name: no image is named.
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('on the shell: the white logo over the product name in the UI language', async () => {
    await i18n.changeLanguage('ar')
    const { container } = at('/platform/companies', <BrandLockup surface="shell" />)
    const lockup = container.querySelector('[data-brand-lockup="shell"]')
    expect(lockup).toHaveTextContent('زوار موضوع')
    expect(lockup?.querySelector('img')).toHaveAttribute('src', '/brand/logo-white.png')
    expect(lockup?.querySelector('source')).toBeNull()
  })

  it('is phrasing content only, so it can be a heading’s text', () => {
    const { container } = at(
      '/platform',
      <h2>
        <BrandLockup surface="shell" />
      </h2>,
    )
    expect(container.querySelectorAll('h2 div, h2 p')).toHaveLength(0)
    expect(screen.getByRole('heading', { name: 'Mawdoo3 Visitors' })).toBeInTheDocument()
  })
})

describe('BrandLogo, in the platform owner’s area', () => {
  it('names the brand when it stands alone', () => {
    at('/platform/companies', <BrandLogo variant="ink" />)
    expect(screen.getByRole('img', { name: 'Mawdoo3' })).toHaveAttribute('src', '/brand/logo-ink.png')
  })
})

describe('outside the platform owner’s area (Phase 12)', () => {
  it.each(['/', '/login', '/c/nova-labs', '/pass', '/visits', '/reception', '/admin', '/platformx', '/no-such-page'])('renders nothing of the product at %s, whoever asks for it', (path) => {
    const { container } = at(
      path,
      <>
        <BrandLockup surface="page" size="lg" />
        <BrandLockup surface="shell" />
        <BrandLogo variant="auto" />
        <BrandLogo variant="white" decorative />
        <BrandLogo variant="ink" />
      </>,
    )
    expect(container).toBeEmptyDOMElement()
  })
})

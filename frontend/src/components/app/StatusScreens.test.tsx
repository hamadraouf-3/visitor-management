import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { AccessDenied } from './StatusScreens'

describe('AccessDenied', () => {
  it('says it in its title, with a way home and no explanatory note (brand pass, decision 3)', () => {
    const { container } = render(
      <MemoryRouter>
        <AccessDenied homePath="/visits" />
      </MemoryRouter>,
    )
    expect(screen.getByRole('heading', { name: 'You do not have access to this page' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to your home page' })).toHaveAttribute('href', '/visits')
    expect(container.querySelectorAll('p')).toHaveLength(0)
  })
})

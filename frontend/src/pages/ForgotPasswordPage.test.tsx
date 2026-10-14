import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { routes } from '../test/appRoutes'
import { errorResponse, jsonResponse, mockApi } from '../test/api'
import { findAlert, renderRoutes } from '../test/render'

// The backend's wording (RESET_REQUEST_ACCEPTED_MESSAGE); the page shows whatever the server sends.
const SERVER_MESSAGE = 'If an account exists for that email address, we have sent instructions to reset the password.'
const ACCEPTED = () => jsonResponse({ message: SERVER_MESSAGE }, 202)

async function requestReset(email: string) {
  const view = renderRoutes(routes, { initialEntries: ['/forgot-password'] })
  await view.user.type(await screen.findByLabelText('Email'), email)
  await view.user.click(screen.getByRole('button', { name: 'Send reset link' }))
  await screen.findByRole('heading', { name: 'Check your email' })
  const text = document.body.textContent ?? ''
  view.unmount()
  return text
}

describe('ForgotPasswordPage', () => {
  it('shows the same confirmation for every address', async () => {
    const { requests } = mockApi({ 'POST /auth/forgot-password': ACCEPTED })

    const known = await requestReset('lina.haddad@example.com')
    const unknown = await requestReset('nobody@example.com')

    expect(known).toBe(unknown)
    expect(known).toContain(SERVER_MESSAGE)
    expect(known).not.toContain('lina.haddad@example.com')
    expect(requests.map((request) => request.body)).toEqual([
      { email: 'lina.haddad@example.com' },
      { email: 'nobody@example.com' },
    ])
  })

  it("shows the server's confirmation text and adds no link lifetime of its own", async () => {
    mockApi({ 'POST /auth/forgot-password': () => jsonResponse({ message: 'Instructions are on their way, if the account exists.' }, 202) })

    const text = await requestReset('lina.haddad@example.com')

    expect(text).toContain('Instructions are on their way, if the account exists.')
    expect(text).not.toMatch(/minute/i)
  })

  it('validates the address before sending and focuses the field', async () => {
    const { requests } = mockApi({})
    const { user } = renderRoutes(routes, { initialEntries: ['/forgot-password'] })

    await user.type(await screen.findByLabelText('Email'), 'not-an-email')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))

    expect(screen.getByText('Enter a valid email address, like name@company.com.')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveFocus()
    expect(requests).toHaveLength(0)
  })

  it('reports failures that never reached the account check (e.g. offline)', async () => {
    mockApi({ 'POST /auth/forgot-password': () => errorResponse(503, 'SERVICE_BUSY', 'The service is busy. Please try again.') })
    const { user } = renderRoutes(routes, { initialEntries: ['/forgot-password'] })

    await user.type(await screen.findByLabelText('Email'), 'lina.haddad@example.com')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))

    expect(await findAlert('The service is busy. Please try again.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send reset link' })).toHaveFocus()
  })
})

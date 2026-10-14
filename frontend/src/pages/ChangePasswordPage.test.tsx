import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { reportsRoutes } from '../features/reports/testRoutes'
import { routes } from '../test/appRoutes'
import { errorResponse, jsonResponse, makeMe, mockApi, noContent } from '../test/api'
import { findAlert, renderRoutes } from '../test/render'

const NEW_PASSWORD = 'violet-harbour-lantern-42'

async function submitChange(user: ReturnType<typeof renderRoutes>['user'], current: string, next: string, confirm = next) {
  await user.type(screen.getByLabelText('Current password'), current)
  await user.type(screen.getByLabelText('New password'), next)
  await user.type(screen.getByLabelText('Confirm new password'), confirm)
  await user.click(screen.getByRole('button', { name: 'Change password' }))
}

describe('ChangePasswordPage', () => {
  it('changes the password voluntarily and confirms with a toast', async () => {
    const { requests } = mockApi({
      'GET /auth/me': () => jsonResponse(makeMe(['EMPLOYEE'])),
      'POST /auth/change-password': () => noContent(),
    })
    const { user, router } = renderRoutes(routes, { initialEntries: ['/change-password'] })
    await screen.findByRole('heading', { level: 1, name: 'Change password' })

    await submitChange(user, 'old-password-123', NEW_PASSWORD)

    expect(await screen.findByText('Password changed')).toBeInTheDocument()
    expect(requests.find((request) => request.path === '/auth/change-password')?.body).toEqual({
      current_password: 'old-password-123',
      new_password: NEW_PASSWORD,
    })
    expect(router.state.location.pathname).toBe('/change-password')
    expect(screen.getByLabelText('Current password')).toHaveValue('')
  })

  it('continues to the landing page after a forced change', async () => {
    let mustChange = true
    mockApi({
      'GET /auth/me': () => jsonResponse(makeMe(['MANAGEMENT'], { must_change_password: mustChange })),
      'POST /auth/change-password': () => {
        mustChange = false
        return noContent()
      },
      ...reportsRoutes(),
    })
    const { user, router } = renderRoutes(routes, { initialEntries: ['/reports'] })
    await screen.findByText('Choose a new password to continue')

    await submitChange(user, 'Temporary-Pass-1', NEW_PASSWORD)

    expect(await screen.findByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/reports')
  })

  it('shows a wrong current password on its field', async () => {
    mockApi({
      'GET /auth/me': () => jsonResponse(makeMe(['EMPLOYEE'])),
      'POST /auth/change-password': () =>
        errorResponse(400, 'INVALID_CURRENT_PASSWORD', 'Your current password is incorrect.'),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/change-password'] })
    await screen.findByRole('heading', { level: 1, name: 'Change password' })

    await submitChange(user, 'wrong-password', NEW_PASSWORD)

    expect(await screen.findByText('Your current password is incorrect.')).toBeInTheDocument()
    const current = screen.getByLabelText('Current password')
    expect(current).toHaveAttribute('aria-invalid', 'true')
    expect(current).toHaveAccessibleDescription('Your current password is incorrect.')
    expect(current).toHaveFocus()
    // Shown once, on the field, not again in the form alert.
    expect(screen.getAllByText('Your current password is incorrect.')).toHaveLength(1)
  })

  it('focuses the new password when the server rejects it', async () => {
    mockApi({
      'GET /auth/me': () => jsonResponse(makeMe(['EMPLOYEE'])),
      'POST /auth/change-password': () =>
        errorResponse(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', {
          fields: { new_password: 'This password is too common.' },
        }),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/change-password'] })
    await screen.findByRole('heading', { level: 1, name: 'Change password' })

    await submitChange(user, 'old-password-123', NEW_PASSWORD)

    const newPassword = await screen.findByLabelText('New password', { selector: '[aria-invalid="true"]' })
    expect(newPassword).toHaveAccessibleDescription('This password is too common.')
    expect(newPassword).toHaveFocus()
    expect(screen.queryByText('Please correct the highlighted fields.')).toBeNull()
  })

  it('keeps focus on the submit button when the failure is not about a field', async () => {
    mockApi({
      'GET /auth/me': () => jsonResponse(makeMe(['EMPLOYEE'])),
      'POST /auth/change-password': () => errorResponse(429, 'RATE_LIMITED', 'Too many requests. Please wait and try again.'),
    })
    const { user } = renderRoutes(routes, { initialEntries: ['/change-password'] })
    await screen.findByRole('heading', { level: 1, name: 'Change password' })

    await submitChange(user, 'old-password-123', NEW_PASSWORD)

    expect(await findAlert('Too many requests. Please wait and try again.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change password' })).toHaveFocus()
  })

  it('focuses the confirmation when it does not match', async () => {
    const { requests } = mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['EMPLOYEE'])) })
    const { user } = renderRoutes(routes, { initialEntries: ['/change-password'] })
    await screen.findByRole('heading', { level: 1, name: 'Change password' })

    await submitChange(user, 'old-password-123', NEW_PASSWORD, `${NEW_PASSWORD}x`)

    expect(screen.getByLabelText('Confirm new password')).toHaveFocus()
    expect(screen.getByLabelText('Confirm new password')).toHaveAccessibleDescription('The passwords do not match.')
    expect(requests.some((request) => request.path === '/auth/change-password')).toBe(false)
  })

  it('applies the client-side policy, including "not your email"', async () => {
    const { requests } = mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['EMPLOYEE'])) })
    const { user } = renderRoutes(routes, { initialEntries: ['/change-password'] })
    await screen.findByRole('heading', { level: 1, name: 'Change password' })

    await submitChange(user, 'old-password-123', 'Lina.Haddad@example.com')

    expect(screen.getByText('Your password must not be your email address.')).toBeInTheDocument()
    expect(requests.some((request) => request.path === '/auth/change-password')).toBe(false)
  })
})

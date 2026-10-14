import { screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../api/queryKeys'
import { routes } from '../test/appRoutes'
import { errorResponse, makeMe, mockApi, noContent } from '../test/api'
import { createTestQueryClient, findAlert, renderBrowserRoutes } from '../test/render'

const TOKEN = 'rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2AXo3_vK9-aQ2'
const NEW_PASSWORD = 'violet-harbour-lantern-42'

describe('ResetPasswordPage', () => {
  let observer: MutationObserver | undefined

  afterEach(() => {
    observer?.disconnect()
  })

  it('removes the token from the address bar before the page renders, then submits it', async () => {
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`)
    const { requests } = mockApi({ 'POST /auth/reset-password': () => noContent() })
    const replaceState = vi.spyOn(window.history, 'replaceState')

    // Record any DOM update that happens while the token is still in the URL.
    const renderedWithToken: string[] = []
    observer = new MutationObserver(() => {
      if (window.location.hash && document.body.textContent?.includes('Choose a new password')) {
        renderedWithToken.push(window.location.hash)
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    const { user } = renderBrowserRoutes(routes)

    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('Choose a new password'))
    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/reset-password')
    expect(window.location.href).not.toContain(TOKEN)
    expect(replaceState).toHaveBeenCalledWith(expect.anything(), '', '/reset-password')
    expect(renderedWithToken).toEqual([])

    // Policy hints are visible.
    expect(screen.getByText('12–128 characters')).toBeInTheDocument()
    expect(screen.getByText('Must not be a commonly used password.')).toBeInTheDocument()

    await user.type(screen.getByLabelText('New password'), NEW_PASSWORD)
    await user.type(screen.getByLabelText('Confirm new password'), NEW_PASSWORD)
    await user.click(screen.getByRole('button', { name: 'Reset password' }))

    expect(await screen.findByRole('heading', { name: 'Your password has been reset' })).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('Your password has been reset'))
    expect(requests.find((request) => request.path === '/auth/reset-password')?.body).toEqual({
      token: TOKEN,
      new_password: NEW_PASSWORD,
    })
  })

  it('ends a session held in this browser once the reset succeeds (the server revoked it)', async () => {
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`)
    mockApi({ 'POST /auth/reset-password': () => noContent() })
    const queryClient = createTestQueryClient()
    queryClient.setQueryData(queryKeys.me, makeMe(['EMPLOYEE']))
    queryClient.setQueryData(queryKeys.visits.list(), { items: [], page: 1, page_size: 25, total: 0 })
    const { user } = renderBrowserRoutes(routes, { queryClient })
    await screen.findByRole('heading', { name: 'Choose a new password' })

    await user.type(screen.getByLabelText('New password'), NEW_PASSWORD)
    await user.type(screen.getByLabelText('Confirm new password'), NEW_PASSWORD)
    await user.click(screen.getByRole('button', { name: 'Reset password' }))

    expect(await screen.findByRole('heading', { name: 'Your password has been reset' })).toBeInTheDocument()
    expect(queryClient.getQueryData(queryKeys.me)).toBeNull()
    expect(queryClient.getQueryData(queryKeys.visits.list())).toBeUndefined()
  })

  it('makes no API call on load', async () => {
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`)
    const { fetchMock } = mockApi({})

    renderBrowserRoutes(routes)

    await screen.findByRole('heading', { name: 'Choose a new password' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the invalid-link state when the link has no token', async () => {
    window.history.replaceState(null, '', '/reset-password')
    mockApi({})

    renderBrowserRoutes(routes)

    expect(await screen.findByRole('heading', { name: 'Link invalid or expired' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/forgot-password')
    // The document title says what the page shows, as its heading does (review: it said "Choose a new password").
    await waitFor(() => expect(document.title).toBe('Link invalid or expired'))
  })

  it('validates the new password locally', async () => {
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`)
    const { requests } = mockApi({})
    const { user } = renderBrowserRoutes(routes)
    await screen.findByRole('heading', { name: 'Choose a new password' })

    await user.type(screen.getByLabelText('New password'), 'short')
    await user.type(screen.getByLabelText('Confirm new password'), 'different')
    await user.click(screen.getByRole('button', { name: 'Reset password' }))

    expect(screen.getByText('Use at least 12 characters.')).toBeInTheDocument()
    expect(screen.getByText('The passwords do not match.')).toBeInTheDocument()
    expect(requests).toHaveLength(0)
  })

  it('shows the server field message for a rejected password', async () => {
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`)
    mockApi({
      'POST /auth/reset-password': () =>
        errorResponse(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', {
          fields: { new_password: 'This password is too common.' },
        }),
    })
    const { user } = renderBrowserRoutes(routes)
    await screen.findByRole('heading', { name: 'Choose a new password' })

    await user.type(screen.getByLabelText('New password'), 'password1234')
    await user.type(screen.getByLabelText('Confirm new password'), 'password1234')
    await user.click(screen.getByRole('button', { name: 'Reset password' }))

    expect(await screen.findByText('This password is too common.')).toBeInTheDocument()
    expect(screen.getByLabelText('New password')).toHaveAccessibleDescription('This password is too common.')
    expect(screen.getByLabelText('New password')).toHaveFocus()
    expect(screen.queryByText('Please correct the highlighted fields.')).toBeNull()
  })

  it('shows a server message for a field the form does not show (the token) in the alert', async () => {
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`)
    mockApi({
      'POST /auth/reset-password': () =>
        errorResponse(422, 'VALIDATION_ERROR', 'Please correct the highlighted fields.', {
          fields: { token: 'Enter at most 128 characters.' },
        }),
    })
    const { user } = renderBrowserRoutes(routes)
    await screen.findByRole('heading', { name: 'Choose a new password' })

    await user.type(screen.getByLabelText('New password'), NEW_PASSWORD)
    await user.type(screen.getByLabelText('Confirm new password'), NEW_PASSWORD)
    await user.click(screen.getByRole('button', { name: 'Reset password' }))

    expect(await findAlert('Enter at most 128 characters.')).toBeInTheDocument()
    expect(screen.getByLabelText('New password')).not.toHaveAttribute('aria-invalid')
    expect(screen.getByRole('button', { name: 'Reset password' })).toHaveFocus()
  })

  it('focuses the first invalid field after local validation', async () => {
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`)
    mockApi({})
    const { user } = renderBrowserRoutes(routes)
    await screen.findByRole('heading', { name: 'Choose a new password' })

    await user.type(screen.getByLabelText('New password'), NEW_PASSWORD)
    await user.click(screen.getByRole('button', { name: 'Reset password' }))

    expect(screen.getByLabelText('Confirm new password')).toHaveFocus()
    expect(screen.getByLabelText('Confirm new password')).toHaveAccessibleDescription('Confirm your new password.')
  })

  it('switches to the invalid-link state when the server rejects the token', async () => {
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`)
    mockApi({
      'POST /auth/reset-password': () =>
        errorResponse(400, 'INVALID_RESET_TOKEN', 'This password reset link is invalid or has expired.'),
    })
    const { user } = renderBrowserRoutes(routes)
    await screen.findByRole('heading', { name: 'Choose a new password' })

    await user.type(screen.getByLabelText('New password'), NEW_PASSWORD)
    await user.type(screen.getByLabelText('Confirm new password'), NEW_PASSWORD)
    await user.click(screen.getByRole('button', { name: 'Reset password' }))

    expect(await screen.findByRole('heading', { name: 'Link invalid or expired' })).toBeInTheDocument()
    await waitFor(() => expect(document.title).toBe('Link invalid or expired'))
    // The title says it; the server's sentence would only repeat it (decision 3 of the brand pass).
    expect(screen.queryByText('This password reset link is invalid or has expired.')).toBeNull()
    expect(screen.getByRole('link', { name: 'Request a new link' })).toBeInTheDocument()
  })
})

import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { routes } from '../../test/appRoutes'
import { errorResponse, jsonResponse, mockApi, type RecordedRequest } from '../../test/api'
import { renderRoutes } from '../../test/render'
import type { EmailTemplate, EmailTemplateUpdate } from '../../types/api'
import { makeEmailTemplate, withOverrides } from '../admin/emailTemplateFixtures'
import { makePlatformCompany, makePlatformMe, platformRoutes } from './testRoutes'

/*
 * A company's e-mail texts, edited by the platform owner (Phase 12): the screens of the company's
 * own administrator (`features/admin/EmailTemplatesPage.test.tsx` holds their behaviour in full) on
 * the endpoints under the company, with the platform session.
 */

const NOVA = makePlatformCompany()
const BASE = `/platform/companies/${NOVA.id}/email-templates`
const LIST = `/platform/companies/${NOVA.id}/email-templates`
const EDITOR = `${LIST}/VISITOR_INVITATION`
const OWNER = makePlatformMe()

const RULE = '-'.repeat(40)

function makePreview(language: 'ar' | 'en') {
  const english = ['Your visit to Nova Labs', '', 'Hello Sara Ahmad,']
  const arabic = ['زيارتك إلى نوفا لابز', '', 'مرحبًا سارة أحمد،']
  const [lead, other, otherName] = language === 'en' ? [english, arabic, 'العربية'] : [arabic, english, 'English']
  return {
    kind: 'VISITOR_INVITATION',
    language,
    subject: language === 'en' ? 'Your visit to Nova Labs | زيارتك إلى نوفا لابز' : 'زيارتك إلى نوفا لابز | Your visit to Nova Labs',
    html: '<!DOCTYPE html><html></html>',
    text: ['Nova Labs', '='.repeat(40), '', ...lead, '', RULE, otherName, RULE, '', ...other, ''].join('\n'),
  }
}

function setup(path: string, { template = makeEmailTemplate(), extra = {} }: { template?: EmailTemplate; extra?: Record<string, (request: RecordedRequest) => Response> } = {}) {
  let current = template
  const api = mockApi({
    ...platformRoutes({ me: OWNER, companies: [NOVA] }),
    [`GET /platform/companies/${NOVA.id}`]: () => jsonResponse(NOVA),
    [`GET /platform/companies/${NOVA.id}/admins`]: () => jsonResponse([]),
    [`GET ${BASE}`]: () => jsonResponse([current, makeEmailTemplate('VISIT_RESCHEDULED'), makeEmailTemplate('VISIT_CANCELLED'), makeEmailTemplate('HOST_ARRIVAL')]),
    [`GET ${BASE}/VISITOR_INVITATION`]: () => jsonResponse(current),
    [`PATCH ${BASE}/VISITOR_INVITATION`]: (request) => {
      const body = request.body as EmailTemplateUpdate
      current = withOverrides(current, { ar: (body.ar ?? {}) as Record<string, string>, en: (body.en ?? {}) as Record<string, string> })
      return jsonResponse(current)
    },
    [`POST ${BASE}/VISITOR_INVITATION/reset`]: () => {
      current = makeEmailTemplate('VISITOR_INVITATION', { updated_at: '2026-10-05T08:00:00Z' })
      return jsonResponse(current)
    },
    [`POST ${BASE}/VISITOR_INVITATION/preview`]: (request) => jsonResponse(makePreview((request.body as { language: 'ar' | 'en' }).language)),
    [`POST ${BASE}/VISITOR_INVITATION/test`]: () => jsonResponse({ sent_to: OWNER.admin.email }, 202),
    ...extra,
  })
  return { ...api, ...renderRoutes(routes, { initialEntries: [path] }) }
}

function control(language: 'ar' | 'en', name: string): HTMLInputElement | HTMLTextAreaElement {
  const element = document.querySelector(`[data-template-field="${language}.${name}"]`)?.querySelector('input, textarea')
  if (!element) throw new Error(`No field ${language}.${name}`)
  return element as HTMLInputElement | HTMLTextAreaElement
}

/** Every request but the platform session's and the company's own. */
function templateRequests(requests: RecordedRequest[]) {
  return requests.filter((request) => request.path.includes('/email-templates')).map((request) => `${request.method} ${request.path}`)
}

describe('a company’s email texts on the platform', () => {
  it('are reached from the company’s page, beside its identity', async () => {
    const { user, router } = setup(`/platform/companies/${NOVA.id}`)
    await screen.findByRole('heading', { level: 1, name: 'Nova Labs' })

    const card = screen.getByRole('heading', { level: 2, name: 'Identity' }).closest('section') as HTMLElement
    expect(within(card).getByRole('link', { name: 'Edit identity' })).toHaveAttribute('href', `/platform/companies/${NOVA.id}/identity`)
    await user.click(within(card).getByRole('link', { name: 'Email texts' }))

    await screen.findByRole('heading', { level: 1, name: 'Email texts' })
    expect(router.state.location.pathname).toBe(LIST)
  })

  it('list the four emails of that company, naming it, with the way back to it', async () => {
    const changed = withOverrides(makeEmailTemplate(), { en: { subject: 'Welcome to {company}' } })
    const { requests } = setup(LIST, { template: changed })
    await screen.findByRole('heading', { level: 1, name: 'Email texts' })

    const list = await screen.findByRole('list', { name: 'Emails' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(4)
    expect(rows[0]).toHaveTextContent('Visitor invitation')
    expect(rows[0]).toHaveTextContent('1 text changed')
    expect(rows[1]).toHaveTextContent('Default texts')
    // Each row leads to the platform's own editor for that company, never to a company page.
    expect(within(rows[0]!).getByRole('link', { name: 'Visitor invitation' })).toHaveAttribute('href', EDITOR)
    // Whose texts they are: the way back above the title names the company, its logo and name head
    // the page, and the tab's title names it (two companies' lists were called the same).
    expect(screen.getByRole('link', { name: 'Nova Labs' })).toHaveAttribute('href', `/platform/companies/${NOVA.id}`)
    const header = screen.getByRole('heading', { level: 1, name: 'Email texts' }).closest('header') as HTMLElement
    expect(header.querySelector('[data-page-subject]')).toHaveTextContent('Nova Labs')
    expect(header.querySelector('[data-company-logo-tile], [aria-hidden="true"] svg')).not.toBeNull()
    await waitFor(() => expect(document.title).toBe('Email texts · Nova Labs · Mawdoo3 Visitors'))

    expect(templateRequests(requests)).toEqual([`GET ${BASE}`])
    // The platform session only: the company's own session and endpoints are never asked.
    expect(requests.some((request) => request.path === '/auth/me' || request.path.startsWith('/email-templates'))).toBe(false)
  })

  it('edit a text with the same checks, preview the draft and save through the platform’s endpoints', async () => {
    document.cookie = 'vms_csrf=company-token; path=/'
    document.cookie = 'vms_platform_csrf=platform-token; path=/'
    const { user, requests } = setup(EDITOR)
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    expect(screen.getByRole('link', { name: 'Email texts' })).toHaveAttribute('href', LIST)
    // Whose e-mail it is: the company's name right above the e-mail's, and in the tab's title.
    const header = screen.getByRole('heading', { level: 1 }).closest('header') as HTMLElement
    expect(header.querySelector('[data-page-subject]')).toHaveTextContent('Nova Labs')
    await waitFor(() => expect(document.title).toBe('Visitor invitation · Nova Labs · Mawdoo3 Visitors'))

    // The company's own checks: a subject must keep the company.
    await user.type(control('en', 'subject'), 'Welcome')
    expect(await screen.findByText('Include “Company” in this text.')).toBeInTheDocument()
    await user.type(control('en', 'subject'), ' to {{company}')
    await waitFor(() => expect(screen.queryByText('Include “Company” in this text.')).toBeNull())

    // The draft, rendered by the platform's preview endpoint.
    const previewed = await waitFor(() => {
      const request = requests.findLast((entry) => entry.method === 'POST' && entry.path === `${BASE}/VISITOR_INVITATION/preview`)
      if ((request?.body as { en?: { subject?: string } } | undefined)?.en?.subject !== 'Welcome to {company}') throw new Error('The draft is not previewed yet')
      return request
    })
    expect(previewed?.body).toMatchObject({ language: 'en', en: { subject: 'Welcome to {company}' } })
    expect(await screen.findByText('Your visit to Nova Labs', { selector: 'bdi' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Email texts saved')).toBeInTheDocument()
    const saved = requests.find((request) => request.method === 'PATCH')
    expect(saved?.path).toBe(`${BASE}/VISITOR_INVITATION`)
    expect(saved?.body).toEqual({ en: { subject: 'Welcome to {company}' } })
    // The platform's own CSRF token vouches for it, never the company's.
    expect(saved?.headers.get('X-CSRF-Token')).toBe('platform-token')
    expect(requests.some((request) => request.path.startsWith('/email-templates'))).toBe(false)
  })

  it('show the saved email in its frame from the platform’s own address, in the leading language', async () => {
    const { user } = setup(EDITOR)
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })

    await user.click(screen.getByRole('tab', { name: 'Saved email' }))
    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-saved-preview]')
    expect(frame).toHaveAttribute('src', `/api/v1${BASE}/VISITOR_INVITATION/preview?language=en&scheme=light`)
    expect(frame).toHaveAttribute('sandbox', '')

    await user.click(screen.getByRole('radio', { name: 'Arabic' }))
    expect(document.querySelector('iframe[data-saved-preview]')).toHaveAttribute('src', `/api/v1${BASE}/VISITOR_INVITATION/preview?language=ar&scheme=light`)
    // Light / Dark (Phase 13): the same e-mail as a mail client in its dark mode shows it.
    await user.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(document.querySelector('iframe[data-saved-preview]')).toHaveAttribute('src', `/api/v1${BASE}/VISITOR_INVITATION/preview?language=ar&scheme=dark`)
  })

  it('send a test to the platform owner’s own address, and say how long to wait when limited', async () => {
    let limited = false
    const { user, requests } = setup(EDITOR, {
      extra: {
        [`POST ${BASE}/VISITOR_INVITATION/test`]: () =>
          limited
            ? new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests.', details: {} }, request_id: 'r' }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '1500' } })
            : jsonResponse({ sent_to: OWNER.admin.email }, 202),
      },
    })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })

    await user.click(screen.getByRole('button', { name: 'Send test' }))
    expect(await screen.findByText('Test email sent')).toBeInTheDocument()
    expect(screen.getByText(`To ${OWNER.admin.email}`)).toBeInTheDocument()
    expect(requests.find((request) => request.path.endsWith('/test'))?.body).toMatchObject({ language: 'en' })

    limited = true
    await user.click(screen.getByRole('button', { name: 'Send test' }))
    expect(await screen.findByText('Too many test emails. Try again in 25 minutes.')).toBeInTheDocument()
  })

  it('reset to the default texts after one line of confirmation', async () => {
    const changed = withOverrides(makeEmailTemplate(), { en: { subject: 'Welcome to {company}' } })
    const { user, requests } = setup(EDITOR, { template: changed })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })

    await user.click(screen.getByRole('button', { name: 'Reset to default texts' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Reset to the default texts?' })
    expect(dialog).toHaveTextContent('Every text of this email goes back to its default text, in both languages.')
    await user.click(within(dialog).getByRole('button', { name: 'Reset texts' }))

    expect(await screen.findByText('Default texts restored')).toBeInTheDocument()
    expect(requests.find((request) => request.path.endsWith('/reset'))?.path).toBe(`${BASE}/VISITOR_INVITATION/reset`)
    expect(control('en', 'subject')).toHaveValue('')
  })

  it('put the server’s refusal on the text it names', async () => {
    const { user } = setup(EDITOR, {
      extra: {
        [`PATCH ${BASE}/VISITOR_INVITATION`]: () =>
          errorResponse(422, 'VALIDATION_ERROR', 'Some fields are invalid.', {
            fields: { 'ar.intro': 'This text cannot hold markup.' },
            field_codes: { 'ar.intro': { code: 'markup_not_allowed', params: {} } },
          }),
      },
    })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    await user.type(control('ar', 'intro'), 'مرحبًا')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(control('ar', 'intro')).toHaveAttribute('aria-invalid', 'true'))
    expect(control('ar', 'intro')).toHaveFocus()
  })

  it('say “Email not found” for a kind that cannot be edited, with the way back to the company’s texts', async () => {
    const { requests } = setup(`${LIST}/AUTH_PASSWORD_RESET`)
    expect(await screen.findByRole('heading', { level: 1, name: 'Email not found' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Email texts' })).toHaveAttribute('href', LIST)
    expect(templateRequests(requests)).toEqual([])
  })

  it('say when the company does not exist', async () => {
    mockApi({ ...platformRoutes(), 'GET /platform/companies/missing': () => errorResponse(404, 'NOT_FOUND', 'Company not found.') })
    renderRoutes(routes, { initialEntries: ['/platform/companies/missing/email-templates'] })
    expect(await screen.findByRole('heading', { level: 1, name: 'Company not found' })).toBeInTheDocument()
  })

  it('are in Arabic for a platform owner who reads Arabic, the company named by its Arabic name', async () => {
    mockApi({
      ...platformRoutes({ me: makePlatformMe({ preferred_language: 'ar' }), companies: [NOVA] }),
      [`GET /platform/companies/${NOVA.id}`]: () => jsonResponse(NOVA),
      [`GET ${BASE}`]: () => jsonResponse([makeEmailTemplate()]),
    })
    renderRoutes(routes, { initialEntries: [LIST] })
    await screen.findByRole('heading', { level: 1, name: 'نصوص الرسائل' })
    expect(screen.getByRole('link', { name: 'نوفا لابز' })).toHaveAttribute('href', `/platform/companies/${NOVA.id}`)
    expect(await screen.findByRole('link', { name: 'دعوة الزائر' })).toHaveAttribute('href', EDITOR)
  })
})

import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import { routes } from '../../test/appRoutes'
import { jsonResponse, makeMe, mockApi } from '../../test/api'
import { renderRoutes } from '../../test/render'
import type { Me } from '../../types/api'
import { formatMetadataValue } from './auditFormat'
import { auditActionLabel, auditEntityLabel } from './auditLabels'
import { auditLogRoutes, makeAuditLog } from './testRoutes'

/*
 * Phase 11 in a company's audit log: what the platform owner did to the company is recorded without
 * an actor, with `metadata.source = "platform"` (B11-5), and shows as "Platform owner"; the e-mail
 * texts' events name the texts that changed in words.
 */

const ADMIN = makeMe(['SYSTEM_ADMIN'])

// A company's rows of what the platform owner did carry no network address and no browser (B11-37): they are the platform's own.
const PLATFORM_RESET = makeAuditLog({
  id: 'a0000000-0000-4000-8000-000000000011',
  action: 'AUTH_PASSWORD_RESET_REQUESTED',
  actor: null,
  entity_type: 'user',
  metadata: { email_message_id: 'b0000000-0000-4000-8000-000000000001', notified_admins: 2, source: 'platform', platform_admin_id: '9a000000-0000-4000-8000-000000000001' },
  ip_address: null,
  user_agent: null,
})
const TEXTS_CHANGED = makeAuditLog({
  id: 'a0000000-0000-4000-8000-000000000012',
  action: 'EMAIL_TEMPLATE_UPDATED',
  entity_type: 'email_template',
  entity_id: null,
  metadata: { kind: 'VISITOR_INVITATION', changed: ['ar.subject', 'en.footer_note'], reset: [] },
})
const DEACTIVATED = makeAuditLog({
  id: 'a0000000-0000-4000-8000-000000000013',
  action: 'COMPANY_DEACTIVATED',
  actor: null,
  entity_type: 'company',
  metadata: { revoked_sessions: 3, invalidated_reset_links: 1, source: 'platform', platform_admin_id: '9a000000-0000-4000-8000-000000000001' },
})

function setup(me: Me = ADMIN) {
  mockApi({ 'GET /auth/me': () => jsonResponse(me), ...auditLogRoutes([PLATFORM_RESET, TEXTS_CHANGED, DEACTIVATED]) })
  return renderRoutes(routes, { initialEntries: ['/admin/audit'] })
}

describe('the platform owner in a company’s audit log', () => {
  it('names the platform owner as who did it, never "System"', async () => {
    const { user } = setup()
    const list = await screen.findByRole('list', { name: 'Audit events, newest first' })
    const [reset, texts, deactivated] = within(list).getAllByRole('listitem')
    expect(reset).toHaveTextContent('Password reset requested')
    expect(reset).toHaveTextContent('Platform owner')
    expect(reset).not.toHaveTextContent('System or anonymous')
    expect(deactivated).toHaveTextContent('Company deactivated')
    expect(deactivated).toHaveTextContent('Platform owner')
    expect(texts).toHaveTextContent('Email texts changed')
    expect(texts).toHaveTextContent('Email texts')

    await user.click(within(texts!).getByRole('button', { name: /Details/ }))
    expect(await within(texts!).findByText('Subject (Arabic), Footer line (English)')).toBeInTheDocument()
    expect(within(texts!).getByText('Visitor invitation')).toBeInTheDocument()
    await user.click(within(deactivated!).getByRole('button', { name: /Details/ }))
    expect(await within(deactivated!).findByText('Reset links invalidated')).toBeInTheDocument()
    expect(within(deactivated!).getAllByText('Platform owner').length).toBeGreaterThan(1)
  })

  it('shows a platform action without a network address or a browser as "Not recorded", never as an empty line', async () => {
    const { user } = setup()
    const list = await screen.findByRole('list', { name: 'Audit events, newest first' })
    const reset = within(list).getAllByRole('listitem')[0]!
    await user.click(within(reset).getByRole('button', { name: /Details/ }))
    const details = document.getElementById(within(reset).getByRole('button', { name: /Details/ }).getAttribute('aria-controls')!)!
    expect(within(details).getByText('IP address').nextElementSibling).toHaveTextContent(/^Not recorded$/)
    expect(within(details).getByText('User agent').nextElementSibling).toHaveTextContent(/^Not recorded$/)
    // Every term of the details has a value in words.
    const empty = [...details.querySelectorAll('dd')].filter((value) => (value.textContent ?? '').trim() === '')
    expect(empty).toHaveLength(0)
    // How many of the company's other administrators were told (B11-43), in words.
    expect(within(details).getByText('Administrators notified').nextElementSibling).toHaveTextContent(/^2$/)
    expect(within(details).getAllByText('Platform owner').length).toBeGreaterThan(0)
  })

  it('names the seed that wrote a row, not "System", and the reasons of the final contract', async () => {
    const seeded = makeAuditLog({ id: 'a0000000-0000-4000-8000-000000000021', action: 'COMPANY_CREATED', actor: null, entity_type: 'company', metadata: { source: 'seed' }, ip_address: null, user_agent: null, request_id: null })
    const refused = makeAuditLog({ id: 'a0000000-0000-4000-8000-000000000022', action: 'AUTH_LOGIN_FAILED', actor: null, entity_type: 'user', metadata: { reason: 'seed_account' } })
    mockApi({ 'GET /auth/me': () => jsonResponse(ADMIN), ...auditLogRoutes([seeded, refused]) })
    renderRoutes(routes, { initialEntries: ['/admin/audit'] })
    const list = await screen.findByRole('list', { name: 'Audit events, newest first' })
    const [first, second] = within(list).getAllByRole('listitem')
    expect(first).toHaveTextContent('Demo data seed')
    expect(first).not.toHaveTextContent('System or anonymous')
    expect(within(second!).getByText('Demo account')).toBeInTheDocument()
    expect(formatMetadataValue('seed', 'source')).toBe('Demo data seed')
    await i18n.changeLanguage('ar')
    expect(formatMetadataValue('seed', 'source')).toBe('تهيئة بيانات العرض')
    expect(formatMetadataValue('seed_account', 'reason')).toBe('حساب العرض')
    expect(formatMetadataValue('user_email_refusals_per_user', 'policy')).not.toMatch(/[A-Za-z]/)
    expect(formatMetadataValue('login_failures_device', 'policy')).not.toMatch(/[A-Za-z]/)
    await i18n.changeLanguage('en')
  })

  it('reads in Arabic', async () => {
    setup({ ...ADMIN, user: { ...ADMIN.user, preferred_language: 'ar' } })
    const list = await screen.findByRole('list', { name: 'أحداث التدقيق، الأحدث أولًا' })
    expect(within(list).getAllByText('مالك المنصة')).toHaveLength(2)
    expect(within(list).getByText('تعديل نصوص الرسالة')).toBeInTheDocument()
    expect(within(list).getByText('تعطيل الشركة')).toBeInTheDocument()
  })

  it('words the Phase 11 actions, entities and values in both languages', async () => {
    expect(auditActionLabel('EMAIL_TEMPLATE_TEST_SENT')).toBe('Test email sent')
    expect(auditEntityLabel('email_template')).toBe('Email texts')
    expect(formatMetadataValue('ar.subject', 'changed')).toBe('Subject (Arabic)')
    expect(formatMetadataValue('platform', 'source')).toBe('Platform owner')
    await i18n.changeLanguage('ar')
    expect(auditActionLabel('COMPANY_REACTIVATED')).toBe('إعادة تفعيل الشركة')
    expect(formatMetadataValue('en.intro', 'changed')).toBe('الفقرة الافتتاحية (الإنجليزية)')
    expect(formatMetadataValue('VISITOR_INVITATION', 'kind')).toBe('دعوة الزائر')
    await i18n.changeLanguage('en')
  })
})

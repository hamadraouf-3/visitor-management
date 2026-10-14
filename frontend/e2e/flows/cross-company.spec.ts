import type { Department } from '../../src/types/api.ts'
import { passToken } from '../support/api.ts'
import { expect, test } from '../support/fixtures.ts'
import { minutes } from '../support/time.ts'
import { resultText, scanPass, scanResult, uniqueTag } from '../support/ui.ts'

/*
 * Tenant isolation (§3.2-5): every ID comes from the caller's company. Other Corp's administrator,
 * employee and receptionist try Demo Company's visit, visitor, pass, users and department through
 * the UI and the API: path IDs answer 404 (no existence oracle), body IDs a 422 field error, a pass
 * the same 404 PASS_INVALID as an unknown one, and nothing of Demo Company changes.
 */

test('Other Corp cannot see or change anything of Demo Company', async ({ open, apiAs }) => {
  const tag = uniqueTag()
  const demoHost = await apiAs('employee')
  const demoAdmin = await apiAs('admin')
  const name = `Salma Odeh ${tag}`
  const now = Date.now()
  const demo = await demoHost.createVisit({
    visitor: { full_name: name, email: `salma.odeh.${tag}@guest.test`, company_name: 'Cedar Advisory' },
    start: new Date(now - minutes(2)),
    end: new Date(now + minutes(58)),
  })
  const demoHostId = (await demoHost.me()).user.id
  const demoDepartment = (await demoAdmin.ok<Department[]>('GET', '/departments'))[0]!
  const before = await demoHost.visit(demo.visit.id)
  const visitId = demo.visit.id
  const visitorId = demo.visit.visitor.id

  // Other Corp's administrator, in the UI.
  const admin = await open({ as: 'otherAdmin' })
  await admin.page.goto(`/visits/${visitId}`)
  await expect(admin.page.getByRole('heading', { level: 1, name: 'Visit not found' })).toBeVisible()
  await admin.page.goto(`/visitors/${visitorId}`)
  await expect(admin.page.getByRole('heading', { level: 1, name: 'Visitor not found' })).toBeVisible()
  await admin.page.goto('/visitors')
  await admin.page.getByRole('searchbox', { name: 'Search visitors' }).fill(name)
  await expect(admin.page.getByRole('heading', { name: new RegExp(`^No visitors match`) })).toBeVisible()
  await admin.page.goto(`/admin/audit?entity_type=visit&entity_id=${visitId}`)
  await expect(admin.page.getByRole('heading', { name: 'No events match these filters' })).toBeVisible()

  // …and through the API.
  for (const [method, path, body] of [
    ['GET', `/visits/${visitId}`],
    ['GET', `/visitors/${visitorId}`],
    ['GET', `/visitors/${visitorId}/visits`],
    ['PATCH', `/visitors/${visitorId}`, { company_name: 'Changed' }],
    ['PATCH', `/visits/${visitId}`, { purpose: 'Changed' }],
    ['POST', `/visits/${visitId}/cancel`, { reason: 'Not ours' }],
    ['POST', `/visits/${visitId}/invitation`],
    ['GET', `/users/${demoHostId}`],
    ['PATCH', `/users/${demoHostId}`, { is_active: false }],
    ['PATCH', `/departments/${demoDepartment.id}`, { name: 'Changed' }],
  ] as const) {
    expect((await admin.api.fails(method, path, 404, body)).error.code, `${method} ${path}`).toBe('NOT_FOUND')
  }
  expect((await admin.api.ok<{ total: number }>('GET', `/visits?scope=all&q=${encodeURIComponent(name)}`)).total).toBe(0)
  expect((await admin.api.ok<{ total: number }>('GET', `/visitors?q=${encodeURIComponent(name)}`)).total).toBe(0)
  expect(await admin.api.auditLogs({ entity_id: visitId })).toEqual([])
  expect((await admin.api.ok<{ id: string }[]>('GET', '/users/hosts')).map((host) => host.id)).not.toContain(demoHostId)

  // Other Corp's employee cannot use Demo Company's IDs in a new visit (422 on the field).
  const employee = await apiAs('otherEmployee')
  const ownHostId = (await employee.me()).user.id
  const schedule = { purpose: 'Cross-company attempt', scheduled_start: new Date(now + minutes(30)).toISOString(), scheduled_end: new Date(now + minutes(90)).toISOString(), send_invitation: false }
  for (const [field, body] of [
    ['host_id', { ...schedule, visitor: { full_name: 'Probe' }, host_id: demoHostId }],
    ['visitor_id', { ...schedule, visitor_id: visitorId, host_id: ownHostId }],
    ['department_id', { ...schedule, visitor: { full_name: 'Probe' }, host_id: ownHostId, department_id: demoDepartment.id }],
  ] as const) {
    const refused = await employee.fails('POST', '/visits', 422, body)
    expect(refused.error.code).toBe('VALIDATION_ERROR')
    expect(Object.keys((refused.error.details as { fields: Record<string, string> }).fields).join(' '), field).toContain(field)
  }

  // Other Corp's reception: the Demo pass is an invalid pass, and the visit cannot be checked in.
  const reception = await open({ as: 'otherReception' })
  await reception.page.goto('/reception')
  const scan = await scanPass(reception.page, demo.pass_url)
  expect(scan.status()).toBe(404)
  await expect(resultText(reception.page, 'Invalid visitor pass.')).toBeVisible()
  await expect(scanResult(reception.page).getByText(name)).toHaveCount(0)
  await reception.api.fails('POST', `/visits/${visitId}/check-in`, 404, { method: 'QR', pass_token: passToken(demo.pass_url) })
  await reception.api.fails('POST', `/visits/${visitId}/check-in`, 404, { method: 'MANUAL' })
  await reception.api.fails('POST', `/visits/${visitId}/check-out`, 404, { method: 'MANUAL' })
  const walkIn = await reception.api.fails('POST', '/reception/walk-ins', 422, {
    visitor_id: visitorId,
    host_id: demoHostId,
    purpose: 'Cross-company attempt',
    expected_end: new Date(now + minutes(60)).toISOString(),
    reason: 'NO_INVITATION',
  })
  expect(walkIn.error.code).toBe('VALIDATION_ERROR')
  expect((await reception.api.inside()).items.map((visit) => visit.id)).not.toContain(visitId)

  // Demo Company's visit is untouched and its pass still works for Demo reception.
  const after = await demoHost.visit(visitId)
  expect(after).toEqual({ ...before, permissions: after.permissions })
  expect((await (await apiAs('reception')).scanReady(passToken(demo.pass_url))).result).toBe('READY')
})

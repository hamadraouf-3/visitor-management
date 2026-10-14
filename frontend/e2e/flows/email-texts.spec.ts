import type { Page } from '@playwright/test'
import type { EmailTemplate } from '../../src/types/api.ts'
import { ACCOUNTS } from '../support/accounts.ts'
import { expect, test } from '../support/fixtures.ts'
import { waitForMessage } from '../support/outbox.ts'
import { minutes } from '../support/time.ts'
import { uniqueTag } from '../support/ui.ts'

/*
 * A company's own e-mail texts (Phase 11, B11-20 … B11-29), through the UI: an administrator edits the
 * invitation's texts (a variable inserted from its chip), sees the draft's preview, saves, sees the
 * saved e-mail in its sandboxed frame, sends a test to their own address, then invites a visitor
 * whose invitation carries the company's words; at the end the texts go back to the default texts.
 *
 * In Other Corp, whose administrator is the e2e company administrator here: the texts are
 * company-wide, and the acceptance and other flow specs read Mawdoo3's invitations in parallel
 * (`support/accounts.ts`: company-wide changes are made in Other Corp). The greeting stays the
 * default one ("Hello <name>,"). Other Corp has no logo and no colour: its name heads its e-mails
 * (Phase 12), and none of them names the product.
 */

const KIND = 'VISITOR_INVITATION'

/** The mean brightness (0–255) of a PNG, measured in the page: a light e-mail is well above the middle, a dark one well below. */
function brightness(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob())
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let sum = 0
    for (let index = 0; index < pixels.length; index += 4) sum += (pixels[index]! + pixels[index + 1]! + pixels[index + 2]!) / 3
    return Math.round(sum / (pixels.length / 4))
  }, png.toString('base64'))
}

test('e-mail texts: edit, preview, save, test, and an invitation in the company’s words', async ({ open, apiAs }) => {
  const tag = uniqueTag()
  const api = await apiAs('otherAdmin')
  const { page } = await open({ as: 'otherAdmin', device: 'desktop' })

  try {
    await page.goto('/admin/email-templates')
    await expect(page.getByRole('heading', { level: 1, name: 'Email texts' })).toBeVisible()
    await page.getByRole('link', { name: 'Visitor invitation' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Visitor invitation' })).toBeVisible()

    const field = (language: 'ar' | 'en', name: string) => page.locator(`[data-template-field="${language}.${name}"]`)
    const subject = field('en', 'subject').getByRole('textbox')
    await expect(subject).toHaveAttribute('placeholder', 'Your visit to {company} on {date}')

    // The server's checks while typing: the subject must name the company.
    await subject.fill(`Your visit ${tag}`)
    await expect(field('en', 'subject')).toContainText('Include “Company” in this text.')
    // A subject may not hold the purpose of a visit, and offers no chip for it; other texts do.
    await subject.fill(`Welcome to {company}: {purpose} ${tag}`)
    await expect(field('en', 'subject')).toContainText('“Purpose” cannot be used in this text.')
    await expect(field('en', 'subject').getByRole('button', { name: 'Insert Purpose' })).toHaveCount(0)
    await expect(field('en', 'closing').getByRole('button', { name: 'Insert Purpose' })).toHaveCount(1)
    await subject.fill(`Welcome to {company} ${tag}`)
    await expect(field('en', 'subject')).not.toContainText('Include “Company” in this text.')
    await expect(field('en', 'subject')).not.toContainText('cannot be used')

    // A variable inserted from the text's own chips (every text has its row of them), at the caret.
    const closing = field('en', 'closing').getByRole('textbox')
    await closing.fill(`See you soon ${tag}, `)
    await closing.press('End')
    await field('en', 'closing').getByRole('button', { name: 'Insert Visitor name' }).click()
    await expect(closing).toHaveValue(`See you soon ${tag}, {visitor_name}`)
    await field('ar', 'footer_note').getByRole('textbox').fill(`موقف السيارات مجاني ${tag}`)

    // The draft's preview: subject and text version with the sample data.
    await expect(page.locator('[data-preview-subject]')).toContainText(`Welcome to Other Corp ${tag}`, { timeout: 15_000 })
    await expect(page.locator('[data-preview-text]')).toContainText(`See you soon ${tag}, Sara Ahmad`)

    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Email texts saved')).toBeVisible()
    await expect(page.getByText('All changes are saved.')).toBeVisible()
    await expect(field('en', 'subject').getByText('Changed')).toBeVisible()

    // The saved e-mail in its sandboxed frame (its own document and style policy).
    await page.getByRole('tab', { name: 'Saved email' }).click()
    const frame = page.locator('[data-saved-preview]')
    await expect(frame).toHaveAttribute('sandbox', '')
    await expect(frame).toHaveAttribute('src', /\/api\/v1\/email-templates\/VISITOR_INVITATION\/preview\?language=en&scheme=light$/)
    await expect(page.frameLocator('[data-saved-preview]').locator('body')).toContainText(`See you soon ${tag}, Sara Ahmad`, { timeout: 15_000 })

    // Light / Dark (Phase 13): Light, the e-mail as a light client shows it, stays light on a device in its
    // dark scheme (a frame's document sees the device's scheme: the server leaves the dark rules out of it);
    // Dark is the same e-mail as a mail client in its dark mode shows it.
    const schemes = page.getByRole('radiogroup', { name: 'Email appearance' })
    await expect(schemes.getByRole('radio', { name: 'Light' })).toBeChecked()
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(async () => brightness(page, await frame.screenshot()), { timeout: 15_000 }).toBeGreaterThan(170)
    await schemes.getByText('Dark', { exact: true }).click()
    await expect(frame).toHaveAttribute('src', /\/api\/v1\/email-templates\/VISITOR_INVITATION\/preview\?language=en&scheme=dark$/)
    await expect(page.frameLocator('[data-saved-preview]').locator('body')).toContainText(`See you soon ${tag}, Sara Ahmad`, { timeout: 15_000 })
    await expect.poll(async () => brightness(page, await frame.screenshot()), { timeout: 15_000 }).toBeLessThan(90)
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(async () => brightness(page, await frame.screenshot()), { timeout: 15_000 }).toBeLessThan(90)
    await schemes.getByText('Light', { exact: true }).click()
    await expect(frame).toHaveAttribute('src', /scheme=light$/)

    // A test to the administrator's own address, "[Test] " before the subject.
    // It is the e-mail the preview shows: English first here, as the preview's "First language" says.
    await page.getByRole('button', { name: 'Send test' }).click()
    await expect(page.getByText('Test email sent')).toBeVisible()
    await expect(page.getByText(`To ${ACCOUNTS.otherAdmin.email}`)).toBeVisible()
    const testMessage = await waitForMessage({ kind: KIND, to: ACCOUNTS.otherAdmin.email, where: (message) => message.subject.includes(tag) })
    expect(testMessage.subject.startsWith('[Test] ')).toBe(true)
    expect(testMessage.subject.startsWith(`[Test] Welcome to Other Corp ${tag}`)).toBe(true)
    expect(testMessage.text).toContain(`See you soon ${tag}, Sara Ahmad`)
    // The company heads its own e-mail. English leads here, so the second part is the Arabic one.
    expect(testMessage.text).toMatch(/^Other Corp\r?\n=+\r?\n/)
    expect(testMessage.text).toMatch(/\n-+\r?\nالعربية\r?\n-+\r?\n/)
    expect(testMessage.text).not.toMatch(/\n-+\r?\nEnglish\r?\n-+\r?\n/)

    // With Arabic chosen as the preview's first language, the test leads with Arabic too (it followed the UI's language).
    await page.getByRole('radio', { name: 'Arabic' }).check({ force: true })
    await expect(frame).toHaveAttribute('src', /\/api\/v1\/email-templates\/VISITOR_INVITATION\/preview\?language=ar&scheme=light$/)
    await page.getByRole('button', { name: 'Send test' }).click()
    const arabicFirst = await waitForMessage({
      kind: KIND,
      to: ACCOUNTS.otherAdmin.email,
      where: (message) => message.subject.includes(tag) && !message.subject.startsWith('[Test] '),
    })
    // The mark before the subject is the leading language's own.
    expect(arabicFirst.subject.startsWith('[رسالة تجريبية] ')).toBe(true)
    expect(arabicFirst.subject.endsWith(`Welcome to Other Corp ${tag}`)).toBe(true)
    // Arabic leads: the second part is the English one, under the company's name.
    expect(arabicFirst.text).toMatch(/^Other Corp\r?\n=+\r?\n/)
    expect(arabicFirst.text).toMatch(/\n-+\r?\nEnglish\r?\n-+\r?\n/)
    expect(arabicFirst.text).not.toMatch(/\n-+\r?\nالعربية\r?\n-+\r?\n/)
    // Nothing in a company's e-mail names the product.
    for (const part of [testMessage.text, testMessage.html, arabicFirst.text, arabicFirst.html]) {
      expect(part).not.toContain('Mawdoo3')
      expect(part).not.toContain('موضوع')
    }

    // A real invitation now carries the company's words.
    const visitorName = `Guest ${tag}`
    const visitorEmail = `guest.${tag}@demo.local`
    const start = new Date(Date.now() + minutes(26 * 60))
    await api.createVisit({ visitor: { full_name: visitorName, email: visitorEmail }, start, end: new Date(start.getTime() + minutes(60)), sendInvitation: true })
    const invitation = await waitForMessage({ kind: KIND, to: visitorEmail })
    expect(invitation.subject).toContain(`Welcome to Other Corp ${tag}`)
    expect(invitation.text).toContain(`Hello ${visitorName},`)
    expect(invitation.text).toContain(`See you soon ${tag}, ${visitorName}`)
    expect(invitation.text).toContain(`موقف السيارات مجاني ${tag}`)

    // Back to the product's texts, after one line of confirmation.
    await page.getByRole('button', { name: 'Reset to default texts' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Reset to the default texts?' })
    await expect(dialog).toContainText('Every text of this email goes back to its default text, in both languages.')
    await dialog.getByRole('button', { name: 'Reset texts' }).click()
    await expect(page.getByText('Default texts restored')).toBeVisible()
    await expect(subject).toHaveValue('')
    const saved = await api.ok<EmailTemplate>('GET', `/email-templates/${KIND}`)
    expect(saved.fields.every((item) => item.override.ar === null && item.override.en === null)).toBe(true)
  } finally {
    // Never leave Other Corp's invitations in this spec's words.
    await api.ok('POST', `/email-templates/${KIND}/reset`, {})
  }
})

test('e-mail texts are an administrator’s: other roles are refused', async ({ apiAs }) => {
  const employee = await apiAs('otherEmployee')
  expect((await employee.fails('GET', '/email-templates', 403)).error.code).toBe('FORBIDDEN')
  // The security e-mails are not editable.
  const admin = await apiAs('otherAdmin')
  expect((await admin.fails('GET', '/email-templates/PASSWORD_RESET', 404)).error.code).toBe('NOT_FOUND')
})

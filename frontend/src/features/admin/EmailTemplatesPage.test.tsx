import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { APPEARANCE_STORAGE_KEY } from '../../appearance/appearance'
import { routes } from '../../test/appRoutes'
import { errorResponse, jsonResponse, makeMe, mockApi, type RecordedRequest } from '../../test/api'
import { myVisitsRoutes } from '../../test/fixtures'
import { renderRoutes } from '../../test/render'
import type { EmailTemplate, EmailTemplateUpdate, Me } from '../../types/api'
import { PREVIEW_DEBOUNCE_MS } from './EmailPreviewCard'
import { makeEmailTemplate, withOverrides } from './emailTemplateFixtures'

const ADMIN = makeMe(['SYSTEM_ADMIN'])
const ARABIC_ADMIN: Me = { ...ADMIN, user: { ...ADMIN.user, preferred_language: 'ar' } }
const PATH = '/admin/email-templates/VISITOR_INVITATION'

/** A value as the e-mail isolates it in a sentence (U+2068 … U+2069). */
const isolated = (value: string) => `${String.fromCharCode(0x2068)}${value}${String.fromCharCode(0x2069)}`
const RULE = '-'.repeat(40)

/** The rendering of a draft as the API answers it: the leading language's section, the other's under its name, the footers. */
function makePreview(language: 'ar' | 'en') {
  const english = ['Your visit to Acme Holdings', '', `Hello ${isolated('سارة أحمد')},`, `${isolated('لينا حداد')} has invited you to visit Acme Holdings.`, `Host: ${isolated('لينا حداد')}`]
  const arabic = ['زيارتك إلى Acme Holdings', '', `مرحبًا ${isolated('Sara Ahmad')}،`, `المضيف: ${isolated('Lina Haddad')}`]
  const [lead, other, otherName] = language === 'en' ? [english, arabic, 'العربية'] : [arabic, english, 'English']
  const subjects = ['Your visit to Acme Holdings on Tuesday, 6 October 2026', 'زيارتك إلى Acme Holdings']
  const footers = ['Sent by Acme Holdings.', `أُرسلت من ${isolated('Acme Holdings')}.`]
  const [leadFooter, otherFooter] = language === 'en' ? footers : footers.toReversed()
  return {
    kind: 'VISITOR_INVITATION',
    language,
    subject: (language === 'en' ? subjects : subjects.toReversed()).join(' | '),
    html: '<!DOCTYPE html><html></html>',
    text: ['Acme Holdings', '='.repeat(40), '', ...lead, '', RULE, otherName, RULE, '', ...other, '', '--', leadFooter, '', otherFooter, ''].join('\n'),
  }
}

function setup({ template = makeEmailTemplate(), me = ADMIN, extra = {} }: { template?: EmailTemplate; me?: Me; extra?: Record<string, (request: RecordedRequest) => Response> } = {}) {
  let current = template
  const api = mockApi({
    'GET /auth/me': () => jsonResponse(me),
    'GET /email-templates': () => jsonResponse([current, makeEmailTemplate('VISIT_RESCHEDULED'), makeEmailTemplate('VISIT_CANCELLED'), makeEmailTemplate('HOST_ARRIVAL')]),
    'GET /email-templates/VISITOR_INVITATION': () => jsonResponse(current),
    'PATCH /email-templates/VISITOR_INVITATION': (request) => {
      const body = request.body as EmailTemplateUpdate
      current = withOverrides(current, { ar: (body.ar ?? {}) as Record<string, string>, en: (body.en ?? {}) as Record<string, string> })
      return jsonResponse(current)
    },
    'POST /email-templates/VISITOR_INVITATION/reset': () => {
      current = makeEmailTemplate('VISITOR_INVITATION', { updated_at: '2026-10-05T08:00:00Z' })
      return jsonResponse(current)
    },
    'POST /email-templates/VISITOR_INVITATION/preview': (request) => jsonResponse(makePreview((request.body as { language: 'ar' | 'en' }).language)),
    'POST /email-templates/VISITOR_INVITATION/test': () => jsonResponse({ sent_to: ADMIN.user.email }, 202),
    ...extra,
  })
  return api
}

/** The control of a field in one language. */
function control(language: 'ar' | 'en', name: string): HTMLInputElement | HTMLTextAreaElement {
  const box = document.querySelector(`[data-template-field="${language}.${name}"]`)
  const element = box?.querySelector('input, textarea')
  if (!element) throw new Error(`No field ${language}.${name}`)
  return element as HTMLInputElement | HTMLTextAreaElement
}

function fieldBox(language: 'ar' | 'en', name: string): HTMLElement {
  return document.querySelector(`[data-template-field="${language}.${name}"]`) as HTMLElement
}

/** The chips of the toolbar named `name`, by their words. */
function chips(name: string): (string | null)[] {
  return within(screen.getByRole('toolbar', { name })).getAllByRole('button').map((chip) => chip.textContent)
}

/** The language section of the draft preview that holds `line`. */
function previewSection(line: string): Element | null {
  return screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === line).closest('[data-preview-section]')
}

describe('the email texts list', () => {
  it('lists the four emails with what the company changed, under Administration', async () => {
    setup({ template: withOverrides(makeEmailTemplate(), { en: { subject: 'Hi {company}' }, ar: { subject: 'أهلًا {company}' } }) })
    renderRoutes(routes, { initialEntries: ['/admin/email-templates'] })

    const list = await screen.findByRole('list', { name: 'Emails' })
    const items = within(list).getAllByRole('listitem')
    expect(items.map((item) => within(item).getByRole('link').textContent)).toEqual(['Visitor invitation', 'Visit rescheduled', 'Visit cancelled', 'Visitor arrival'])
    expect(items[0]).toHaveTextContent('2 texts changed')
    expect(items[0]).toHaveTextContent('To the visitor')
    // One name for the default texts in English too, as «النصوص الأصلية» in Arabic.
    expect(items[1]).toHaveTextContent('Default texts')
    expect(items[3]).toHaveTextContent('To the host')
    expect(within(items[0]!).getByRole('link')).toHaveAttribute('href', PATH)
    // "Email", as the rest of the product writes it (UX review M2).
    expect(screen.getByRole('heading', { level: 1, name: 'Email texts' })).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Main navigation' })
    expect(within(nav).getByRole('link', { name: 'Email texts' })).toHaveAttribute('aria-current', 'page')
  })

  it('is for administrators only', async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(makeMe(['EMPLOYEE'])), ...myVisitsRoutes() })
    const { router } = renderRoutes(routes, { initialEntries: [PATH] })
    expect(await screen.findByRole('heading', { level: 1, name: 'My visits' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/visits')
  })
})

describe('the email texts editor', () => {
  it('shows every field in both languages, each in its own direction with the product’s text as its placeholder', async () => {
    setup()
    renderRoutes(routes, { initialEntries: [PATH] })
    expect(await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })).toBeInTheDocument()
    expect(control('ar', 'subject')).toHaveAttribute('dir', 'rtl')
    expect(control('ar', 'subject')).toHaveAttribute('lang', 'ar')
    expect(control('ar', 'subject')).toHaveAttribute('placeholder', 'زيارتك إلى {company} يوم {date}')
    expect(control('en', 'intro')).toHaveAttribute('dir', 'ltr')
    expect(control('en', 'intro').tagName).toBe('TEXTAREA')
    expect(control('en', 'button')).toHaveAttribute('placeholder', 'Open my visitor pass')
    expect(screen.getByText('Default texts')).toBeInTheDocument()
    // The rule of the subject, met by the product's text.
    expect(within(fieldBox('en', 'subject')).getByText('Must include Company')).toBeInTheDocument()
  })

  it('is laid out by field: a field’s Arabic and English texts are one group, next to each other in the page (UX review L8)', async () => {
    setup()
    renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    // One heading and one group per field, in the template's order; no block per language.
    expect(within(screen.getByRole('main')).getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Subject',
      'Heading',
      'Greeting',
      'Opening paragraph',
      'Button',
      'Closing paragraph',
      'Footer line',
      'Preview',
    ])
    const subject = screen.getByRole('group', { name: 'Subject' })
    // Each text is labelled by its language under the field's heading; its accessible name says both.
    expect([...subject.querySelectorAll('label > span[aria-hidden="true"]')].map((label) => label.textContent)).toEqual(['Arabic', 'English'])
    expect(within(subject).getAllByRole('textbox')).toHaveLength(2)
    expect(within(subject).getByRole('textbox', { name: 'Subject (Arabic)' })).toBe(control('ar', 'subject'))
    expect(within(subject).getByRole('textbox', { name: 'Subject (English)' })).toBe(control('en', 'subject'))
    // In the page's order the two languages of a field follow each other: nothing of another field lies between them.
    const order = [...document.querySelectorAll('[data-template-field]')].map((box) => box.getAttribute('data-template-field'))
    expect(order.slice(0, 4)).toEqual(['ar.subject', 'en.subject', 'ar.heading', 'en.heading'])
    // The side-by-side grid starts at the tablet's width; below it the cells stack.
    expect(control('ar', 'subject').closest('[data-template-field]')?.parentElement).toHaveClass('grid-cols-1', 'md:grid-cols-2')
  })

  it('checks a text while it is typed, as the server would', async () => {
    setup()
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    await user.type(control('en', 'subject'), 'Your visit on {{date}')
    expect(within(fieldBox('en', 'subject')).getByText('Include “Company” in this text.')).toBeInTheDocument()
    expect(control('en', 'subject')).toHaveAttribute('aria-invalid', 'true')
    await user.clear(control('en', 'subject'))
    await user.type(control('en', 'subject'), 'Hi {{nickname}')
    expect(within(fieldBox('en', 'subject')).getByText('“nickname” is not a variable of this email.')).toBeInTheDocument()
    await user.type(control('ar', 'intro'), '<b>مرحبًا</b>')
    expect(within(fieldBox('ar', 'intro')).getByText('Write plain text: tags and HTML character references are not allowed.')).toBeInTheDocument()
    await user.type(control('en', 'closing'), 'Bye {{{{company}}')
    expect(within(fieldBox('en', 'closing')).getByText('Write a variable as its name in braces, for example {visitor_name}; braces mark variables only.')).toBeInTheDocument()
    // The draft preview waits for a valid draft.
    expect(screen.getByText('Correct the highlighted fields.')).toBeInTheDocument()
  })

  it('refuses the purpose in a subject and a fourth use of one variable, naming the variable as its chip does (B11-40)', async () => {
    const { requests } = setup()
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    await user.type(control('en', 'subject'), '{{company}: {{purpose}')
    expect(within(fieldBox('en', 'subject')).getByText('“Purpose” cannot be used in this text.')).toBeInTheDocument()
    await user.type(control('ar', 'intro'), '{{company} {{company} {{company}')
    expect(fieldBox('ar', 'intro').querySelector('[id$="-error"]')).toBeNull()
    await user.type(control('ar', 'intro'), ' {{company}')
    expect(within(fieldBox('ar', 'intro')).getByText('Use “Company” at most 3 times in this text.')).toBeInTheDocument()
    // Nothing is sent while the draft has a problem; the first one in the page's order takes focus.
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(control('en', 'subject')).toHaveFocus())
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false)
  })

  it('shows from the start what is wrong with a text saved before a rule, which the e-mails no longer use (B11-40)', async () => {
    const stored = withOverrides(makeEmailTemplate(), { en: { subject: 'Visit to {company}: {purpose}', heading: 'Welcome to {company}' } })
    const { requests } = setup({ template: stored })
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    // Nobody has typed: the stored subject says why it is not used, and names the variable by its label.
    expect(control('en', 'subject')).toHaveValue('Visit to {company}: {purpose}')
    expect(within(fieldBox('en', 'subject')).getByText('“Purpose” cannot be used in this text.')).toBeInTheDocument()
    expect(control('en', 'subject')).toHaveAccessibleDescription(expect.stringContaining('“Purpose” cannot be used in this text.'))
    expect(control('en', 'subject')).toBeInvalid()
    // A saved text that passes, and the texts never set, show nothing.
    expect(fieldBox('en', 'heading').querySelector('[id$="-error"]')).toBeNull()
    expect(document.querySelectorAll('[data-template-field] [id$="-error"]')).toHaveLength(1)
    // Corrected, the message goes and the text can be saved.
    await user.clear(control('en', 'subject'))
    await user.type(control('en', 'subject'), 'Visit to {{company}')
    expect(fieldBox('en', 'subject').querySelector('[id$="-error"]')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(requests.some((request) => request.method === 'PATCH')).toBe(true))
    expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({ en: { subject: 'Visit to {company}' } })
  })

  it('offers every text its variables at one place, and inserts one at that text’s caret (UX review L7)', async () => {
    setup()
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    // Under every text from the start, not only under the one being edited: nothing appears or moves on focus.
    const toolbars = screen.getAllByRole('toolbar')
    expect(toolbars).toHaveLength(14)
    expect(toolbars.map((toolbar) => toolbar.getAttribute('aria-label')).slice(0, 2)).toEqual(['Variables: Subject (Arabic)', 'Variables: Subject (English)'])
    expect(new Set(toolbars.map((toolbar) => toolbar.getAttribute('aria-label'))).size).toBe(14)
    // A text's chips are the variables it may hold: a subject has no "Purpose" (the server refuses it there), the other texts all eight.
    expect(chips('Variables: Subject (English)')).toEqual(['Visitor name', 'Company', 'Host name', 'Date', 'Time', 'Time zone', 'Department'])
    expect(chips('Variables: Subject (Arabic)')).toHaveLength(7)
    expect(chips('Variables: Heading (English)')).toEqual(['Visitor name', 'Company', 'Host name', 'Date', 'Time', 'Time zone', 'Department', 'Purpose'])
    expect(toolbars.map((toolbar) => within(toolbar).getAllByRole('button').length)).toEqual([7, 7, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8])

    await user.click(control('en', 'closing'))
    await user.keyboard('See you, ')
    expect(screen.getAllByRole('toolbar')).toHaveLength(14)
    await user.click(within(fieldBox('en', 'closing')).getByRole('button', { name: 'Insert Visitor name' }))
    expect(control('en', 'closing')).toHaveValue('See you, {visitor_name}')
    expect(control('en', 'closing')).toHaveFocus()
    await user.keyboard('!')
    expect(control('en', 'closing')).toHaveValue('See you, {visitor_name}!')
    // Another text's chip goes into that text, wherever the caret was last.
    await user.click(within(fieldBox('ar', 'footer_note')).getByRole('button', { name: 'Insert Company' }))
    expect(control('ar', 'footer_note')).toHaveValue('{company}')
    expect(control('ar', 'footer_note')).toHaveFocus()
    expect(control('en', 'closing')).toHaveValue('See you, {visitor_name}!')
  })

  it('makes a text’s variables one tab stop, with the arrow keys between them (UX review M6)', async () => {
    setup()
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    const closing = fieldBox('en', 'closing')
    await user.click(control('en', 'closing'))
    await user.keyboard('See you, ')
    // Tab from the text reaches its variables; the arrow keys choose one; Enter inserts at the caret and returns to the text.
    await user.tab()
    expect(within(closing).getByRole('button', { name: 'Insert Visitor name' })).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(within(closing).getByRole('button', { name: 'Insert Company' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(within(closing).getByRole('button', { name: 'Insert Purpose' })).toHaveFocus()
    await user.keyboard('{Home}{ArrowRight}{ArrowRight}{Enter}')
    expect(control('en', 'closing')).toHaveValue('See you, {host_name}')
    expect(control('en', 'closing')).toHaveFocus()
    // One stop: the next Tab after the variables leaves them for the next text's controls.
    await user.tab()
    expect(within(closing).getByRole('button', { name: 'Insert Host name' })).toHaveFocus()
    await user.tab()
    expect(closing).not.toContainElement(document.activeElement as HTMLElement)

    // From the first text to the Save button it was 138 presses of Tab: every chip of every text was a stop.
    const stops = [...screen.getByRole('main').querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')].filter((element) => element.tabIndex >= 0)
    const between = stops.slice(stops.indexOf(control('ar', 'subject')) + 1, stops.indexOf(screen.getByRole('button', { name: 'Save' })) + 1)
    expect(between.length).toBeGreaterThan(14)
    expect(between.length).toBeLessThanOrEqual(46)
    // Of a text's eight chips, one is a stop.
    expect(between.filter((element) => element.closest('[role="toolbar"]'))).toHaveLength(14)
  })

  it('starts from the product’s text, or goes back to it, by buttons whose names start with their words (UX review L2)', async () => {
    setup()
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    const edit = screen.getByRole('button', { name: 'Edit default text: Greeting (English)' })
    expect(edit).toHaveTextContent('Edit default text')
    await user.click(edit)
    expect(control('en', 'greeting')).toHaveValue('Hello {visitor_name},')
    const useDefault = screen.getByRole('button', { name: 'Use default text: Greeting (English)' })
    expect(useDefault).toHaveTextContent(/^Use default text$/)
    await user.click(useDefault)
    expect(control('en', 'greeting')).toHaveValue('')
    expect(screen.getByText('All changes are saved.')).toBeInTheDocument()
    // Every button of the editor that has a name of its own: the name holds the visible words (WCAG 2.5.3) …
    const named = [...screen.getByRole('main').querySelectorAll('button[aria-label]')].map((button) => ({ name: button.getAttribute('aria-label') ?? '', words: button.textContent?.trim() ?? '' }))
    expect(named.length).toBeGreaterThan(100)
    expect(named.filter((button) => button.words !== '' && !button.name.includes(button.words))).toEqual([])
    // … and the two above each text start with them.
    const aboveText = [...document.querySelectorAll('[data-template-field] > div:first-child button')].map((button) => ({ name: button.getAttribute('aria-label') ?? '', words: button.textContent?.trim() ?? '' }))
    expect(aboveText.length).toBeGreaterThanOrEqual(10)
    expect(aboveText.filter((button) => !button.name.startsWith(`${button.words}: `))).toEqual([])
  })

  it('saves only the fields that changed, and starts again from the saved texts', async () => {
    const { requests } = setup({ template: withOverrides(makeEmailTemplate(), { ar: { closing: 'نراك قريبًا' } }) })
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    expect(within(fieldBox('ar', 'closing')).getByText('Changed')).toBeInTheDocument()
    await user.type(control('en', 'subject'), 'Welcome to {{company}')
    await user.clear(control('ar', 'closing'))
    expect(screen.getByText('You have unsaved changes.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText('Email texts saved')).toBeInTheDocument()
    expect(requests.find((request) => request.method === 'PATCH')?.body).toEqual({ ar: { closing: null }, en: { subject: 'Welcome to {company}' } })
    expect(screen.getByText('All changes are saved.')).toBeInTheDocument()
    expect(within(fieldBox('en', 'subject')).getByText('Changed')).toBeInTheDocument()
  })

  it('asks before leaving with unsaved texts, naming the email’s texts, not the company settings (UX review M1)', async () => {
    setup({ extra: { 'GET /audit-logs': () => jsonResponse({ items: [], page: 1, page_size: 50, total: 0 }) } })
    const { user, router } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    await user.type(control('en', 'closing'), 'Thanks')
    await user.click(within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name: 'Audit log' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave without saving?' })
    expect(dialog).toHaveAccessibleDescription("Your changes to this email's texts have not been saved.")
    expect(dialog).not.toHaveTextContent('company settings')
    await user.click(within(dialog).getByRole('button', { name: 'Stay on this page' }))
    expect(router.state.location.pathname).toBe(PATH)
    expect(control('en', 'closing')).toHaveValue('Thanks')
  })

  it('refuses to save a draft with a problem, and focuses it', async () => {
    const { requests } = setup()
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    await user.type(control('ar', 'button'), 'x'.repeat(41))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(control('ar', 'button')).toHaveFocus())
    expect(within(fieldBox('ar', 'button')).getByText('Enter at most 40 characters.')).toBeInTheDocument()
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false)
  })

  it('puts the server’s field errors on their fields, in the other language too', async () => {
    setup({
      extra: {
        'PATCH /email-templates/VISITOR_INVITATION': () =>
          errorResponse(422, 'VALIDATION_ERROR', 'Invalid', {
            fields: { 'ar.intro': 'Write plain text: tags and HTML character references are not allowed.' },
            field_codes: { 'ar.intro': { code: 'markup_not_allowed', params: {} } },
          }),
      },
    })
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    await user.type(control('en', 'closing'), 'Thanks')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await within(fieldBox('ar', 'intro')).findByText('Write plain text: tags and HTML character references are not allowed.')).toBeInTheDocument()
    await waitFor(() => expect(control('ar', 'intro')).toHaveFocus())
  })

  it.each([
    ['en', ADMIN, 'Visitor invitation', 'Save', '“Purpose” cannot be used in this text.'],
    ['ar', ARABIC_ADMIN, 'دعوة الزائر', 'حفظ', 'لا يمكن استخدام «الغرض» في هذا النص.'],
  ] as const)('names the variable of a server refusal by its label, not in braces (%s)', async (_language, me, title, saveLabel, message) => {
    // A page that still holds the rules of before (no forbidden variable): its own check passes, the server refuses.
    const before = makeEmailTemplate()
    const stale = { ...before, fields: before.fields.map((item) => ({ ...item, forbidden_variables: [] })) }
    setup({
      template: stale,
      me,
      extra: {
        'PATCH /email-templates/VISITOR_INVITATION': () =>
          errorResponse(422, 'VALIDATION_ERROR', 'Invalid', {
            fields: { 'en.subject': '{purpose} cannot be used in this text.' },
            field_codes: { 'en.subject': { code: 'placeholder_not_allowed', params: { name: 'purpose' } } },
          }),
      },
    })
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: title })
    await user.type(control('en', 'subject'), '{{company}: {{purpose}')
    await user.click(screen.getByRole('button', { name: saveLabel }))
    expect(await within(fieldBox('en', 'subject')).findByText(message)).toBeInTheDocument()
    expect(fieldBox('en', 'subject')).not.toHaveTextContent('{purpose} cannot')
    await waitFor(() => expect(control('en', 'subject')).toHaveFocus())
  })

  it('resets to the product’s texts after one line of confirmation', async () => {
    const { requests } = setup({ template: withOverrides(makeEmailTemplate(), { en: { subject: 'Hi {company}' } }) })
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    expect(control('en', 'subject')).toHaveValue('Hi {company}')
    await user.click(screen.getByRole('button', { name: 'Reset to default texts' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Reset to the default texts?' })
    expect(dialog).toHaveAccessibleDescription('Every text of this email goes back to its default text, in both languages.')
    await user.click(within(dialog).getByRole('button', { name: 'Reset texts' }))
    expect(await screen.findByText('Default texts restored')).toBeInTheDocument()
    // "The product's texts" was the other English name: gone from the page.
    expect(document.body.textContent).not.toMatch(/product['’]s/i)
    expect(control('en', 'subject')).toHaveValue('')
    expect(requests.find((request) => request.path.endsWith('/reset'))?.body).toEqual({})
  })

  it('sends a test of the draft to the administrator and says where', async () => {
    const { requests } = setup()
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    await user.type(control('en', 'footer_note'), 'Parking is free.')
    await user.click(screen.getByRole('button', { name: 'Send test' }))
    expect(await screen.findByText('Test email sent')).toBeInTheDocument()
    expect(screen.getByText('To lina.haddad@example.com')).toBeInTheDocument()
    const body = requests.find((request) => request.path.endsWith('/test'))?.body as { language: string; en: Record<string, unknown> }
    expect(body.language).toBe('en')
    expect(body.en.footer_note).toBe('Parking is free.')
  })

  it('sends the test with the language the preview shows first, not the UI’s (UX review L6)', async () => {
    const { requests } = setup()
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    await user.click(screen.getByRole('radio', { name: 'Arabic' }))
    await user.click(screen.getByRole('button', { name: 'Send test' }))
    expect(await screen.findByText('Test email sent')).toBeInTheDocument()
    const tests = () => requests.filter((request) => request.path.endsWith('/test')).map((request) => (request.body as { language: string }).language)
    expect(tests()).toEqual(['ar'])
    await user.click(screen.getByRole('radio', { name: 'English' }))
    await user.click(screen.getByRole('button', { name: 'Send test' }))
    await waitFor(() => expect(tests()).toEqual(['ar', 'en']))
  })

  it('says how long to wait after the hourly limit of tests', async () => {
    setup({
      extra: {
        'POST /email-templates/VISITOR_INVITATION/test': () =>
          new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait and try again.', details: {} }, request_id: 'r' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '1500' },
          }),
      },
    })
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    await user.click(screen.getByRole('button', { name: 'Send test' }))
    expect(await screen.findByText('Too many test emails. Try again in 25 minutes.')).toBeInTheDocument()
  })

  it('previews the draft’s subject and text version, and shows the saved email in a sandboxed frame', async () => {
    const { requests } = setup()
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    const subject = await waitFor(
      () => {
        const element = document.querySelector('[data-preview-subject]')
        expect(element).toHaveTextContent(makePreview('en').subject)
        return element as HTMLElement
      },
      { timeout: 3000 },
    )
    expect(subject).toHaveAttribute('dir', 'ltr')
    await user.type(control('en', 'closing'), 'Bye')
    await waitFor(() => expect(requests.filter((request) => request.path.endsWith('/preview')).length).toBe(2), { timeout: 3000 })
    const lastPreview = requests.filter((request) => request.path.endsWith('/preview')).at(-1)!.body as { en: Record<string, unknown> }
    expect(lastPreview.en.closing).toBe('Bye')

    await user.click(screen.getByRole('radio', { name: 'Arabic' }))
    await user.click(screen.getByRole('tab', { name: 'Saved email' }))
    const frame = screen.getByTitle('Saved email, Arabic first')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame).toHaveAttribute('sandbox', '')
    expect(frame).toHaveAttribute('src', '/api/v1/email-templates/VISITOR_INVITATION/preview?language=ar&scheme=light')
  })

  it('shows the e-mail light, as sent, or as a mail client in its dark mode shows it, whatever the app’s own scheme (Phase 13)', async () => {
    const { requests } = setup()
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, 'dark')
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    const previews = () => requests.filter((request) => request.path.endsWith('/preview'))
    // The draft is its subject and its text version, which have no colours: it is asked for without a scheme.
    await waitFor(() => expect(previews()).toHaveLength(1), { timeout: 3000 })
    expect(previews()[0]!.body).toMatchObject({ language: 'en' })
    expect(previews()[0]!.body).not.toHaveProperty('scheme')

    await user.click(screen.getByRole('tab', { name: 'Saved email' }))
    // Named for the e-mail: not the device's own appearance.
    const schemes = screen.getByRole('radiogroup', { name: 'Email appearance' })
    expect(screen.queryByRole('radiogroup', { name: 'Appearance' })).toBeNull()
    expect(within(schemes).getAllByRole('radio').map((radio) => [radio.getAttribute('value'), (radio as HTMLInputElement).checked])).toEqual([
      ['light', true],
      ['dark', false],
    ])
    expect(within(schemes).getByRole('radio', { name: 'Light' })).toBeChecked()
    const light = screen.getByTitle('Saved email, English first')
    expect(light).toHaveAttribute('src', '/api/v1/email-templates/VISITOR_INVITATION/preview?language=en&scheme=light')
    // The frame itself is light too: its canvas while the document loads, its scrollbars.
    expect(light).toHaveClass('scheme-light', 'bg-white')

    await user.click(within(schemes).getByRole('radio', { name: 'Dark' }))
    const dark = screen.getByTitle('Saved email, English first')
    expect(dark).not.toBe(light)
    expect(dark).toHaveAttribute('src', '/api/v1/email-templates/VISITOR_INVITATION/preview?language=en&scheme=dark')
    expect(dark).toHaveClass('scheme-dark', 'bg-ink-950')

    // Back on the draft after Dark: the same subject at once, and nothing asked again. The test e-mail is
    // the real one, both schemes inside: never with a scheme either.
    const asked = previews().length
    await user.click(screen.getByRole('tab', { name: 'Draft' }))
    expect(document.querySelector('[data-preview-subject]')).toHaveTextContent(makePreview('en').subject)
    expect(screen.queryByText('Updating the preview…')).toBeNull()
    await new Promise((resolve) => window.setTimeout(resolve, PREVIEW_DEBOUNCE_MS + 150))
    expect(previews()).toHaveLength(asked)
    await user.click(screen.getByRole('button', { name: 'Send test' }))
    await waitFor(() => expect(requests.some((request) => request.path.endsWith('/test'))).toBe(true))
    expect(requests.find((request) => request.path.endsWith('/test'))?.body).not.toHaveProperty('scheme')
  })

  it('sets each line of the draft in its section’s direction and language, whatever script a name in it has (UX review L3, L5)', async () => {
    setup()
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'Visitor invitation' })
    const section = previewSection
    // English leads: its lines hold Arabic names and stay left to right, in English.
    const hello = await waitFor(() => section(`Hello ${isolated('سارة أحمد')},`), { timeout: 3000 })
    expect(hello).toHaveAttribute('dir', 'ltr')
    expect(hello).toHaveAttribute('lang', 'en')
    expect(section(`Host: ${isolated('لينا حداد')}`)).toBe(hello)
    expect(section(`${isolated('لينا حداد')} has invited you to visit Acme Holdings.`)).toBe(hello)
    // The Arabic section's lines hold Latin names and stay right to left, in Arabic.
    const marhaba = section(`مرحبًا ${isolated('Sara Ahmad')}،`)
    expect(marhaba).toHaveAttribute('dir', 'rtl')
    expect(marhaba).toHaveAttribute('lang', 'ar')
    expect(section(`المضيف: ${isolated('Lina Haddad')}`)).toBe(marhaba)
    expect(section('زيارتك إلى Acme Holdings')).toBe(marhaba)
    // The footers, each in its language; the subject's two halves too.
    expect(section('Sent by Acme Holdings.')).toHaveAttribute('lang', 'en')
    expect(section(`أُرسلت من ${isolated('Acme Holdings')}.`)).toHaveAttribute('lang', 'ar')
    const subject = document.querySelector('[data-preview-subject]')!
    expect([...subject.querySelectorAll('bdi')].map((part) => [part.getAttribute('lang'), part.getAttribute('dir')])).toEqual([
      ['en', 'ltr'],
      ['ar', 'rtl'],
    ])
    expect(document.querySelectorAll('[data-preview-text] [dir="auto"], [data-preview-text] p[dir]')).toHaveLength(0)

    // Arabic first: the sections change places, and the subject leads right to left.
    await user.click(screen.getByRole('radio', { name: 'Arabic' }))
    await waitFor(() => expect(document.querySelector('[data-preview-subject]')).toHaveAttribute('dir', 'rtl'), { timeout: 3000 })
    expect([...document.querySelectorAll('[data-preview-section]')].map((element) => element.getAttribute('lang'))).toEqual(['ar', 'en', 'ar', 'en'])
    expect(section(`Hello ${isolated('سارة أحمد')},`)).toHaveAttribute('dir', 'ltr')
  })

  it('says when the email is not one of the four', async () => {
    mockApi({ 'GET /auth/me': () => jsonResponse(ADMIN) })
    renderRoutes(routes, { initialEntries: ['/admin/email-templates/PASSWORD_RESET'] })
    expect(await screen.findByRole('heading', { level: 1, name: 'Email not found' })).toBeInTheDocument()
  })

  it('reads in Arabic, right to left, with the variables named in Arabic and the product’s own words (UX review M2, wording)', async () => {
    setup({ me: ARABIC_ADMIN, template: withOverrides(makeEmailTemplate(), { en: { subject: 'Hi {company}' } }) })
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    expect(await screen.findByRole('heading', { level: 1, name: 'دعوة الزائر' })).toBeInTheDocument()
    expect(document.documentElement.dir).toBe('rtl')
    // «رسالة», as every older screen says, never «إيميل»; the page and the navigation item are «نصوص الرسائل».
    expect(screen.getByRole('link', { name: 'نصوص الرسائل', current: 'page' })).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('إيميل')
    const subject = screen.getByRole('group', { name: 'الموضوع' })
    expect(within(subject).getByRole('textbox', { name: 'الموضوع (العربية)' })).toBe(control('ar', 'subject'))
    expect(within(subject).getByRole('textbox', { name: 'الموضوع (الإنجليزية)' })).toBe(control('en', 'subject'))
    expect(within(fieldBox('en', 'subject')).getByText('معدّل')).toBeInTheDocument()
    expect(within(fieldBox('ar', 'intro')).getByRole('button', { name: 'إدراج اسم الزائر' })).toBeInTheDocument()
    expect(screen.getByRole('toolbar', { name: 'المتغيّرات: الفقرة الافتتاحية (العربية)' })).toBeInTheDocument()
    // One name for the default texts, «النصوص الأصلية»: on the fields' buttons, the reset and its confirmation.
    expect(within(fieldBox('en', 'subject')).getByRole('button', { name: 'استعادة النص الأصلي: الموضوع (الإنجليزية)' })).toHaveTextContent('استعادة النص الأصلي')
    expect(within(fieldBox('ar', 'subject')).getByRole('button', { name: 'تعديل النص الأصلي: الموضوع (العربية)' })).toHaveTextContent('تعديل النص الأصلي')
    expect(within(fieldBox('ar', 'subject')).getByText('يجب أن يتضمن المتغيّر «الشركة»')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'إرسال رسالة تجريبية' })).toBeInTheDocument()
    await user.type(control('ar', 'subject'), 'زيارتك')
    expect(within(fieldBox('ar', 'subject')).getByText('أدرج «الشركة» في هذا النص.')).toBeInTheDocument()
    await user.type(control('ar', 'heading'), 'زيارتك {{{{company}}')
    expect(within(fieldBox('ar', 'heading')).getByText('اكتب المتغيّر بين حاصرتين، هكذا: {visitor_name}. الحاصرتان للمتغيّرات فقط.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'استعادة النصوص الأصلية' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'استعادة النصوص الأصلية؟' })
    expect(dialog).toHaveAccessibleDescription('تعود جميع نصوص هذه الرسالة إلى النصوص الأصلية، باللغتين.')
  })

  it('says in Arabic how long to wait for the next test, in whole words (wording)', async () => {
    setup({
      me: ARABIC_ADMIN,
      extra: {
        'POST /email-templates/VISITOR_INVITATION/test': () =>
          new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait and try again.', details: {} }, request_id: 'r' }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '3540' },
          }),
      },
    })
    const { user } = renderRoutes(routes, { initialEntries: [PATH] })
    await screen.findByRole('heading', { level: 1, name: 'دعوة الزائر' })
    await user.click(screen.getByRole('button', { name: 'إرسال رسالة تجريبية' }))
    expect(await screen.findByText('بلغت الحد المسموح من الرسائل التجريبية. حاول مجددًا بعد 59 دقيقة.')).toBeInTheDocument()
  })
})

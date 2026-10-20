import { describe, expect, it } from 'vitest'
import { i18n } from '../../i18n'
import type { EmailTemplateKind } from '../../types/api'
import { makeEmailTemplate, withOverrides } from './emailTemplateFixtures'
import {
  checkTemplateText,
  customisedCount,
  draftFromTemplate,
  draftProblems,
  fieldVariables,
  insertVariable,
  isEmailTemplateKind,
  lineLanguage,
  lineLanguages,
  placeholdersOf,
  previewSubjectParts,
  previewTextSections,
  refusedSavedTexts,
  serverProblemMessage,
  templateProblemMessage,
  templateRecipient,
  textLength,
  toPreviewRequest,
  toTemplateUpdate,
  variableLabel,
} from './emailTemplateForm'

const TEMPLATE = makeEmailTemplate()
const field = (name: string) => TEMPLATE.fields.find((item) => item.name === name)!
const check = (name: string, text: string) => checkTemplateText(field(name), TEMPLATE, text)
const char = (code: number) => String.fromCharCode(code)

/*
 * The editor checks what the server checks (backend `app/email/editable.py`, `check_text`), in the
 * same order and with the same codes, so a problem shows while typing in the words the server's 422
 * would use.
 */
describe('checking a text as the server does', () => {
  it('accepts an empty text (the product’s) and plain text with the kind’s variables', () => {
    expect(check('subject', '')).toBeNull()
    expect(check('subject', '   ')).toBeNull()
    expect(check('subject', 'Welcome to {company} on {date}')).toBeNull()
    expect(check('intro', 'Line one\nLine two with a < b and R&D, {host_name}.')).toBeNull()
  })

  it('measures length after trimming, in characters', () => {
    expect(check('button', 'x'.repeat(40))).toBeNull()
    expect(check('button', ` ${'x'.repeat(40)}\n`)).toBeNull()
    expect(check('button', 'x'.repeat(41))).toEqual({ code: 'too_long', params: { max: 40 } })
    expect(textLength('😀a')).toBe(2)
  })

  it('refuses line breaks and tabs in a one-line field, and control or direction characters anywhere', () => {
    expect(check('subject', 'Visit {company}\nnow')).toEqual({ code: 'line_breaks', params: {} })
    expect(check('subject', 'Visit\t{company}')).toEqual({ code: 'line_breaks', params: {} })
    expect(check('intro', 'Visit\tus')).toEqual({ code: 'control_characters', params: {} })
    expect(check('intro', `Visit${char(0x2028)}us`)).toEqual({ code: 'control_characters', params: {} })
    expect(check('intro', `Visit ${char(0x202e)}us`)).toEqual({ code: 'bidi_controls', params: {} })
    expect(check('intro', `Visit ${char(0x2067)}us${char(0x2069)}`)).toEqual({ code: 'bidi_controls', params: {} })
    // Marks that only steer neutral characters (LRM, RLM) are text.
    expect(check('intro', `Visit ${char(0x200f)}us`)).toBeNull()
  })

  it('refuses markup but not a lone < or &', () => {
    for (const text of ['<b>hi</b>', 'a </p>', '<!-- x -->', '<?php', 'a &amp; b', '&#60;', '&#x3c;']) expect(check('intro', text)?.code).toBe('markup_not_allowed')
    expect(check('intro', 'a < b & c > d')).toBeNull()
  })

  it('refuses braces that are not a variable, then unknown variables, then a missing required one', () => {
    for (const text of ['{{company}}', '{Company}', '{company.name}', '{company!r}', '{x:>9}', 'a { b', 'a } b']) expect(check('intro', text)?.code).toBe('invalid_placeholder')
    expect(check('intro', 'Hi {visitor_company}')).toEqual({ code: 'unknown_placeholder', params: { name: 'visitor_company', allowed: TEMPLATE.variables } })
    expect(check('subject', 'Your visit on {date}')).toEqual({ code: 'placeholder_required', params: { name: 'company' } })
    expect(checkTemplateText(makeEmailTemplate('HOST_ARRIVAL').fields[0]!, makeEmailTemplate('HOST_ARRIVAL'), 'Arrived: {visitor_company}')).toEqual({
      code: 'placeholder_required',
      params: { name: 'visitor_name' },
    })
  })

  it('refuses a variable its text may not hold, and one used more often than the kind allows (B11-40)', () => {
    // The purpose of a visit is not a variable of a subject; any other text may hold it.
    expect(field('subject').forbidden_variables).toEqual(['purpose'])
    expect(check('subject', 'Visit to {company}: {purpose}')).toEqual({ code: 'placeholder_not_allowed', params: { name: 'purpose' } })
    expect(check('intro', 'About {purpose}.')).toBeNull()
    // At most three of one variable in one text; three are fine, and so are three each of two.
    expect(TEMPLATE.max_variable_uses).toBe(3)
    expect(check('intro', '{company} {company} {company}')).toBeNull()
    expect(check('intro', '{company} {date} {company} {date} {company} {date}')).toBeNull()
    expect(check('intro', '{company} {company} {company} {company}')).toEqual({ code: 'placeholder_repeated', params: { name: 'company', max: 3 } })
    // The limit is the template's, not a number of the editor's own.
    expect(checkTemplateText(field('intro'), { ...TEMPLATE, max_variable_uses: 1 }, '{date} and {date}')).toEqual({ code: 'placeholder_repeated', params: { name: 'date', max: 1 } })
  })

  it('reports the server’s first problem: unknown, then not allowed here, then repeated, then missing', () => {
    expect(check('subject', '{nickname} {purpose} {date} {date} {date} {date}')?.code).toBe('unknown_placeholder')
    expect(check('subject', '{purpose} {date} {date} {date} {date}')?.code).toBe('placeholder_not_allowed')
    expect(check('subject', '{date} {date} {date} {date}')?.code).toBe('placeholder_repeated')
    expect(check('subject', '{date} {date} {date}')?.code).toBe('placeholder_required')
    // The first variable in the text that breaks the rule is the one named.
    expect(check('intro', '{date} {time} {time} {time} {time} {date} {date} {date}')).toEqual({ code: 'placeholder_repeated', params: { name: 'date', max: 3 } })
  })

  it('offers a text only the variables it may hold', () => {
    expect(fieldVariables(field('subject'), TEMPLATE.variables)).toEqual(['visitor_name', 'company', 'host_name', 'date', 'time', 'timezone', 'department'])
    expect(fieldVariables(field('intro'), TEMPLATE.variables)).toEqual(TEMPLATE.variables)
  })

  it('words each problem as the field code catalog does, in both languages', async () => {
    expect(templateProblemMessage({ code: 'too_long', params: { max: 40 } }, 'en')).toBe('Enter at most 40 characters.')
    expect(templateProblemMessage({ code: 'placeholder_required', params: { name: 'company' } }, 'en')).toBe('Include “Company” in this text.')
    expect(templateProblemMessage({ code: 'unknown_placeholder', params: { name: 'x', allowed: ['a'] } }, 'en')).toBe('“x” is not a variable of this email.')
    expect(templateProblemMessage({ code: 'unknown_placeholder', params: { name: 'x', allowed: ['a'] } }, 'ar')).toBe('«x» ليس من متغيّرات هذه الرسالة.')
    expect(templateProblemMessage({ code: 'markup_not_allowed', params: {} }, 'ar')).toBe('اكتب نصًا عاديًا دون وسوم أو رموز برمجية.')
    // The braces by their Arabic name («حاصرتان»; «قوسان معقوفان» are square brackets), with an example in both languages (UX review M3).
    expect(templateProblemMessage({ code: 'invalid_placeholder', params: {} }, 'en')).toBe(
      'Write a variable as its name in braces, for example {visitor_name}; braces mark variables only.',
    )
    expect(templateProblemMessage({ code: 'invalid_placeholder', params: {} }, 'ar')).toBe('اكتب المتغيّر بين حاصرتين، هكذا: {visitor_name}. الحاصرتان للمتغيّرات فقط.')
    expect(templateProblemMessage({ code: 'placeholder_required', params: { name: 'company' } }, 'ar')).toBe('أدرج «الشركة» في هذا النص.')
    expect(templateProblemMessage({ code: 'too_long', params: { max: 40 } }, 'ar')).toBe('أدخل 40 حرفًا على الأكثر.')
    // The variable by its label, as its chip names it; the count with its Arabic plural.
    expect(templateProblemMessage({ code: 'placeholder_not_allowed', params: { name: 'purpose' } }, 'en')).toBe('“Purpose” cannot be used in this text.')
    expect(templateProblemMessage({ code: 'placeholder_not_allowed', params: { name: 'purpose' } }, 'ar')).toBe('لا يمكن استخدام «الغرض» في هذا النص.')
    expect(templateProblemMessage({ code: 'placeholder_repeated', params: { name: 'company', max: 3 } }, 'en')).toBe('Use “Company” at most 3 times in this text.')
    expect(templateProblemMessage({ code: 'placeholder_repeated', params: { name: 'company', max: 1 } }, 'en')).toBe('Use “Company” only once in this text.')
    expect(templateProblemMessage({ code: 'placeholder_repeated', params: { name: 'company', max: 3 } }, 'ar')).toBe('استخدم «الشركة» 3 مرات على الأكثر في هذا النص.')
    expect(templateProblemMessage({ code: 'placeholder_repeated', params: { name: 'company', max: 2 } }, 'ar')).toBe('استخدم «الشركة» مرتين على الأكثر في هذا النص.')
    expect(templateProblemMessage({ code: 'placeholder_repeated', params: { name: 'company', max: 1 } }, 'ar')).toBe('استخدم «الشركة» مرة واحدة على الأكثر في هذا النص.')
    await i18n.changeLanguage('en')
  })

  it('collects the draft’s problems by language and field', () => {
    const draft = draftFromTemplate(TEMPLATE)
    draft.en.subject = 'No company here'
    draft.ar.intro = '<i>x</i>'
    expect(Object.keys(draftProblems(TEMPLATE, draft)).toSorted()).toEqual(['ar.intro', 'en.subject'])
  })
})

describe('a refusal of the server', () => {
  it('names a variable by its label where the server writes it in braces', () => {
    const notAllowed = { code: 'placeholder_not_allowed', params: { name: 'purpose' } }
    expect(serverProblemMessage('{purpose} cannot be used in this text.', notAllowed, 'en')).toBe('“Purpose” cannot be used in this text.')
    expect(serverProblemMessage('{purpose} cannot be used in this text.', notAllowed, 'ar')).toBe('لا يمكن استخدام «الغرض» في هذا النص.')
    const repeated = { code: 'placeholder_repeated', params: { name: 'company', max: 3 } }
    expect(serverProblemMessage('Use {company} at most 3 times in this text.', repeated, 'en')).toBe('Use “Company” at most 3 times in this text.')
    expect(serverProblemMessage('Use {company} at most 3 times in this text.', repeated, 'ar')).toBe('استخدم «الشركة» 3 مرات على الأكثر في هذا النص.')
    expect(serverProblemMessage('Include {company} in this text.', { code: 'placeholder_required', params: { name: 'company' } }, 'en')).toBe('Include “Company” in this text.')
  })

  it('keeps the server’s words for every other code, and when a parameter is missing', () => {
    expect(serverProblemMessage('Enter at most 40 characters.', { code: 'too_long', params: { max: 40 } }, 'en')).toBe('Enter at most 40 characters.')
    expect(serverProblemMessage('Something newer.', undefined, 'en')).toBe('Something newer.')
    expect(serverProblemMessage('{purpose} cannot be used in this text.', { code: 'placeholder_not_allowed', params: {} }, 'en')).toBe('{purpose} cannot be used in this text.')
    expect(serverProblemMessage('Use {company} at most 3 times in this text.', { code: 'placeholder_repeated', params: { name: 'company' } }, 'ar')).toBe('Use {company} at most 3 times in this text.')
  })
})

describe('saved texts that a newer rule refuses', () => {
  it('names them in the page’s order, and no text that passes or was never set', () => {
    expect(refusedSavedTexts(TEMPLATE)).toEqual([])
    const stored = withOverrides(TEMPLATE, {
      en: { subject: `{company}${'{purpose}'.repeat(15)}`, heading: 'A heading that passes', intro: '{purpose}'.repeat(111) },
      ar: { intro: 'أهلًا بك في {company}' },
    })
    expect(refusedSavedTexts(stored)).toEqual(['en.subject', 'en.intro'])
    // The draft made from it has the same problems, by the codes the server would answer.
    const problems = draftProblems(stored, draftFromTemplate(stored))
    expect(problems['en.subject']?.code).toBe('placeholder_not_allowed')
    expect(problems['en.intro']).toEqual({ code: 'placeholder_repeated', params: { name: 'purpose', max: 3 } })
  })
})

describe('the request bodies', () => {
  it('sends only what changed: a new text, an emptied one as null (the product’s again)', () => {
    const saved = withOverrides(TEMPLATE, { en: { closing: 'See you {visitor_name}.' }, ar: { heading: 'أهلًا في {company}' } })
    const draft = draftFromTemplate(saved)
    expect(toTemplateUpdate(saved, draft)).toBeNull()
    draft.en.closing = '  See you {visitor_name}.  '
    expect(toTemplateUpdate(saved, draft)).toBeNull()
    draft.en.closing = ''
    draft.en.subject = 'Welcome to {company}\r\n'
    expect(toTemplateUpdate(saved, draft)).toEqual({ en: { subject: 'Welcome to {company}', closing: null } })
  })

  it('previews and tests the whole draft of the kind’s fields, the leading language first', () => {
    const template = makeEmailTemplate('VISIT_CANCELLED')
    const draft = draftFromTemplate(template)
    draft.ar.closing = 'شكرًا'
    const body = toPreviewRequest(template, draft, 'ar')
    expect(body.language).toBe('ar')
    expect(body.ar).toEqual({ subject: null, heading: null, greeting: null, intro: null, closing: 'شكرًا', footer_note: null })
    // A kind without a button never sends one (the server refuses it: `not_allowed`).
    expect(body.en && 'button' in body.en).toBe(false)
  })

  it('counts the company’s texts, each language on its own', () => {
    expect(customisedCount(TEMPLATE)).toBe(0)
    expect(customisedCount(withOverrides(TEMPLATE, { en: { subject: 'x {company}', intro: 'y' }, ar: { subject: 'ع {company}' } }))).toBe(3)
  })
})

describe('variables', () => {
  it('inserts a variable at the caret, in place of a selection, or at the end', () => {
    expect(insertVariable('Hello ', 6, 6, 'visitor_name')).toEqual({ value: 'Hello {visitor_name}', caret: 20 })
    expect(insertVariable('Hello X!', 6, 7, 'visitor_name')).toEqual({ value: 'Hello {visitor_name}!', caret: 20 })
    expect(insertVariable('Hi', null, null, 'date')).toEqual({ value: 'Hi{date}', caret: 8 })
  })

  it('reads the variables a text uses, and names each in the UI language', async () => {
    expect(placeholdersOf('{a} and {b_2} but not {C} or {{d}}')).toEqual(['a', 'b_2', 'd'])
    expect(variableLabel('visitor_company')).toBe("Visitor's company")
    expect(variableLabel('brand_new')).toBe('brand_new')
    await i18n.changeLanguage('ar')
    expect(variableLabel('visitor_name')).toBe('اسم الزائر')
    await i18n.changeLanguage('en')
  })

  it('knows the seven kinds, and who receives each', () => {
    expect(isEmailTemplateKind('HOST_ARRIVAL')).toBe(true)
    for (const kind of ['HOST_VISIT_SCHEDULED', 'HOST_VISIT_RESCHEDULED', 'HOST_VISIT_CANCELLED']) {
      expect(isEmailTemplateKind(kind)).toBe(true)
      expect(templateRecipient(kind as EmailTemplateKind)).toBe('host')
    }
    expect(templateRecipient('VISIT_CANCELLED')).toBe('visitor')
    // Not editable (Phase 14): the visitor's calendar e-mail has no words of the company's.
    expect(isEmailTemplateKind('VISITOR_CALENDAR')).toBe(false)
    expect(isEmailTemplateKind('PASSWORD_RESET')).toBe(false)
    expect(isEmailTemplateKind(undefined)).toBe(false)
  })
})

/*
 * The draft preview sets each line of the text version in the direction of the language section it
 * stands in, and gives it that language (UX review L3, L5). The texts here are laid out as the
 * backend writes them (`backend/app/email/templates/base.txt`): the leading language's section, the
 * other language's under its name between two rules, and after `--` the two footers. Names and
 * companies are isolated (U+2068 … U+2069), as `app.email.bidi` does.
 */
const isolated = (value: string) => `${char(0x2068)}${value}${char(0x2069)}`

/** The language of a line of `lines`, by the line (the first one that reads so). */
function languageOf(lines: string[], lead: 'ar' | 'en') {
  const languages = lineLanguages(lines, lead)
  return (line: string) => languages[lines.indexOf(line)]
}

describe('the text version’s language sections', () => {
  const RULE = '-'.repeat(40)
  const LINK = 'http://127.0.0.1:5950/pass#sample-not-a-visitor-pass'

  const ENGLISH = [
    'Your visit to Mawdoo3',
    '',
    `Hello ${isolated('سارة أحمد')},`,
    '',
    `${isolated('أمل حداد')} has invited you to visit Mawdoo3.`,
    '',
    'Date: Wednesday, 14 October 2026',
    'Time: 10:00 – 11:00 (Amman time, UTC+3)',
    `Host: ${isolated('أمل حداد')}`,
    // A company's own words, in the other script and not isolated: more Arabic letters than Latin ones.
    'Room: قاعة الاجتماعات الكبرى في الطابق الثالث',
    '',
    LINK,
  ]
  const ARABIC = [
    'زيارتك إلى موضوع',
    '',
    `مرحبًا ${isolated('Sara Ahmad')}،`,
    '',
    `تلقّيت دعوةً من ${isolated('Amal Haddad')} لزيارة ${isolated('Mawdoo3')}.`,
    // More Latin letters than Arabic ones, in the Arabic section.
    'شبكة الزوار: Mawdoo3-Guest / Welcome-2026-Visitors',
    `المضيف: ${isolated('Amal Haddad')}`,
    '',
    LINK,
  ]
  const ENGLISH_FOOTER = ['Sent by Mawdoo3.', `Questions: ${isolated('الاستقبال')}, extension 100.`]
  const ARABIC_FOOTER = [`أُرسلت من ${isolated('موضوع')}.`, 'للاستفسار: الاستقبال، داخلي 100.']

  const ENGLISH_FIRST = ['Mawdoo3 | موضوع', '='.repeat(40), '', ...ENGLISH, '', RULE, 'العربية', RULE, '', ...ARABIC, '', '--', ...ENGLISH_FOOTER, '', ...ARABIC_FOOTER, '']
  const ARABIC_FIRST = ['موضوع | Mawdoo3', '='.repeat(40), '', ...ARABIC, '', RULE, 'English', RULE, '', ...ENGLISH, '', '--', ...ARABIC_FOOTER, '', ...ENGLISH_FOOTER, '']

  /** The lines of a section that hold words (the link stands in both sections: it is told apart by its place, below). */
  const words = (lines: string[]) => lines.filter((line) => line !== '' && line !== LINK)

  it('gives every line of a section its language, whatever script a name or a value in it has', () => {
    const english = languageOf(ENGLISH_FIRST, 'en')
    // English lines holding Arabic names were set right to left; so was one with more Arabic letters than Latin.
    expect(words(ENGLISH).map(english)).toEqual(words(ENGLISH).map(() => 'en'))
    expect(words(ARABIC).map(english)).toEqual(words(ARABIC).map(() => 'ar'))
    const arabic = languageOf(ARABIC_FIRST, 'ar')
    expect(words(ARABIC).map(arabic)).toEqual(words(ARABIC).map(() => 'ar'))
    expect(words(ENGLISH).map(arabic)).toEqual(words(ENGLISH).map(() => 'en'))
  })

  it('reads the two footers after the mark by their own letters, the isolated values aside', () => {
    const english = languageOf(ENGLISH_FIRST, 'en')
    expect(ENGLISH_FOOTER.map(english)).toEqual(['en', 'en'])
    expect(ARABIC_FOOTER.map(english)).toEqual(['ar', 'ar'])
    const arabic = languageOf(ARABIC_FIRST, 'ar')
    expect(ARABIC_FOOTER.map(arabic)).toEqual(['ar', 'ar'])
    expect(ENGLISH_FOOTER.map(arabic)).toEqual(['en', 'en'])
  })

  it('splits the text into its sections in reading order, the lines kept as they are', () => {
    const sections = previewTextSections(ENGLISH_FIRST.join('\n'), 'en')
    expect(sections.map((section) => section.language)).toEqual(['en', 'ar', 'en', 'ar'])
    expect(sections[0]!.lines[0]).toBe('Mawdoo3 | موضوع')
    // The link of each section stays in it: the same line in both, told apart by where it stands.
    expect(sections[0]!.lines).toContain(LINK)
    expect(sections[1]!.lines.slice(0, 3)).toEqual([RULE, 'العربية', RULE])
    expect(sections[1]!.lines).toContain(LINK)
    expect(sections[2]!.lines).toEqual(['--', ...ENGLISH_FOOTER, ''])
    expect(sections[3]!.lines).toEqual(ARABIC_FOOTER)
    expect(sections.flatMap((section) => section.lines)).toEqual(ENGLISH_FIRST.slice(0, -1))

    expect(previewTextSections(ARABIC_FIRST.join('\r\n'), 'ar').map((section) => section.language)).toEqual(['ar', 'en', 'ar', 'en'])
  })

  it('takes the last mark as the footer’s: a company’s closing may hold one', () => {
    const lines = ['Mawdoo3 | موضوع', '='.repeat(40), 'Hello,', RULE, 'العربية', RULE, 'مرحبًا،', '--', 'فريق الاستقبال', '', '--', 'Sent by Mawdoo3.', '', `أُرسلت من ${isolated('موضوع')}.`]
    expect(lineLanguages(lines, 'en')).toEqual(['en', 'en', 'en', 'ar', 'ar', 'ar', 'ar', 'ar', 'ar', 'ar', 'en', 'en', 'en', 'ar'])
  })

  it('reads a company’s own footer (Phase 12): one line per language, with nothing between them, whatever script its name is in', () => {
    const body = ['='.repeat(40), 'Hello,', RULE, 'العربية', RULE, 'مرحبًا،', '--']
    // As the server writes it: "Sent by <company>." then the Arabic line, the name isolated where its script differs.
    expect(lineLanguages(['Mawdoo3 | موضوع', ...body, 'Sent by Mawdoo3.', `أُرسلت من ${isolated('موضوع')}.`], 'en').slice(-2)).toEqual(['en', 'ar'])
    expect(lineLanguages(['Other Corp', ...body, 'Sent by Other Corp.', `أُرسلت من ${isolated('Other Corp')}.`], 'en').slice(-2)).toEqual(['en', 'ar'])
    // A company named in Arabic only: the English line is still English.
    expect(lineLanguages(['موضوع', ...body, `Sent by ${isolated('موضوع')}.`, `أُرسلت من ${isolated('موضوع')}.`], 'en').slice(-2)).toEqual(['en', 'ar'])
    const sections = previewTextSections(['Other Corp', ...body, 'Sent by Other Corp.', `أُرسلت من ${isolated('Other Corp')}.`, ''].join('\n'), 'en')
    expect(sections.map((section) => section.language)).toEqual(['en', 'ar', 'en', 'ar'])
    expect(sections.at(-1)!.lines).toEqual([`أُرسلت من ${isolated('Other Corp')}.`])
  })

  it('reads a text without the other language’s title line by line, a line without letters as the one before', () => {
    const lines = [`Hello ${isolated('سارة أحمد')},`, RULE, '10:00 – 11:00', `مرحبًا ${isolated('Sara Ahmad')}،`, '12:30']
    expect(lineLanguages(lines, 'ar')).toEqual(['en', 'en', 'en', 'ar', 'ar'])
    expect(lineLanguages(['10:00', 'Hello'], 'ar')).toEqual(['ar', 'en'])
  })

  it('tells a line’s own language, the values isolated in it aside', () => {
    expect(lineLanguage(`${isolated('أمل حداد')} has invited you to visit Mawdoo3.`)).toBe('en')
    expect(lineLanguage(`Host: ${isolated('أمل حداد')}`)).toBe('en')
    expect(lineLanguage(`المضيف: ${isolated('Amal Haddad')}`)).toBe('ar')
    expect(lineLanguage(`تلقّيت دعوةً من ${isolated('Amal Haddad')} لزيارة ${isolated('Northwind Logistics International')}.`)).toBe('ar')
    // Nothing but an isolated value, a time, a rule: no language of its own.
    expect(lineLanguage(isolated('Mawdoo3'))).toBeNull()
    expect(lineLanguage('10:00 – 11:00')).toBeNull()
    expect(lineLanguage(RULE)).toBeNull()
    // An isolate left open runs to the end of its line (UAX #9).
    expect(lineLanguage(`مرحبًا ${char(0x2068)}Sara Ahmad of Northwind Logistics`)).toBe('ar')
  })

  it('splits the subject at its one separator, the leading language first', () => {
    expect(previewSubjectParts('Your visit to Mawdoo3 | زيارتك إلى موضوع', 'en')).toEqual([
      { language: 'en', text: 'Your visit to Mawdoo3' },
      { language: 'ar', text: 'زيارتك إلى موضوع' },
    ])
    expect(previewSubjectParts('زيارتك إلى موضوع | Your visit to Mawdoo3', 'ar').map((part) => part.language)).toEqual(['ar', 'en'])
    // A company's own subject may hold the separator: then the whole subject is the leading language's.
    expect(previewSubjectParts('Mawdoo3 | Visits | زيارتك', 'en')).toEqual([{ language: 'en', text: 'Mawdoo3 | Visits | زيارتك' }])
    expect(previewSubjectParts('Your visit', 'ar')).toEqual([{ language: 'ar', text: 'Your visit' }])
  })
})

import type { FieldCodeEntry } from '../../api/client'
import { currentLanguage, LANGUAGE_NAMES, type Language } from '../../i18n'
import { catalogText } from '../../i18n/catalogText'
import { fieldCodeValues } from '../../i18n/fieldMessages'
import type { EmailTemplate, EmailTemplateFieldName, EmailTemplateKind, EmailTemplatePreviewRequest, EmailTemplateUpdate } from '../../types/api'

/*
 * A company's e-mail texts (Phase 11, B11-20 … B11-27, B11-40): the editor's draft, the checks the
 * server makes (mirrored here so a problem shows while typing, with the server's codes and words), and
 * the request bodies. The server stays the judge: its 422 field errors land on the same fields.
 */

/** The languages in the order the editor shows them: Arabic first (the product's default), then English. */
export const TEMPLATE_LANGUAGES: readonly Language[] = ['ar', 'en']

/** The seven kinds (three to the visitor; four to the host, three of them since Phase 14), in the order the API lists them. */
export const EMAIL_TEMPLATE_KINDS: readonly EmailTemplateKind[] = [
  'VISITOR_INVITATION',
  'VISIT_RESCHEDULED',
  'VISIT_CANCELLED',
  'HOST_ARRIVAL',
  'HOST_VISIT_SCHEDULED',
  'HOST_VISIT_RESCHEDULED',
  'HOST_VISIT_CANCELLED',
]

export function isEmailTemplateKind(value: string | undefined): value is EmailTemplateKind {
  return (EMAIL_TEMPLATE_KINDS as readonly (string | undefined)[]).includes(value)
}

/** Who receives the kind: the visitor, or the host (a visitor's arrival; a visit created, moved or cancelled, Phase 14). */
export function templateRecipient(kind: EmailTemplateKind): 'visitor' | 'host' {
  return kind.startsWith('HOST_') ? 'host' : 'visitor'
}

export type TemplateField = EmailTemplate['fields'][number]

/** The editor's texts: per language and field, what the field holds ('' = the product's text). */
export type TemplateDraft = Record<Language, Partial<Record<EmailTemplateFieldName, string>>>

/** A field of the form, as the server reports it: `ar.subject`, `en.intro`. */
export type TemplateFieldKey = `${Language}.${EmailTemplateFieldName}`

export function fieldKey(language: Language, field: EmailTemplateFieldName): TemplateFieldKey {
  return `${language}.${field}`
}

/** The draft of the saved texts: each field holds the company's text, or '' where the product's applies. */
export function draftFromTemplate(template: EmailTemplate): TemplateDraft {
  const draft: TemplateDraft = { ar: {}, en: {} }
  for (const field of template.fields) {
    for (const language of TEMPLATE_LANGUAGES) draft[language][field.name] = field.override[language] ?? ''
  }
  return draft
}

/** A text as the server stores it: CRLF and CR become LF, white space at both ends goes (B11-24). */
export function normaliseTemplateText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim()
}

/** Length in characters as the server counts them (code points). */
export function textLength(value: string): number {
  return [...value].length
}

/* The server's checks, in its order (backend `app/email/editable.py`, `check_text`) ------------------ */

/** A placeholder: `{name}`, lowercase letters, digits and underscores, starting with a letter. */
const PLACEHOLDER = /\{([a-z][a-z0-9_]*)\}/g
const BRACE = /[{}]/
/** A tag opener (`<b`, `</`, `<!`, `<?`) or a character reference (`&amp;`, `&#60;`, `&#x3c;`); a lone `<` or `&` is text. */
const MARKUP = /<[A-Za-z/!?]|&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/
const char = (code: number) => String.fromCharCode(code)
/** C0 other than LF, DEL, C1, and the Unicode line and paragraph separators. */
const CONTROL = new RegExp(`[\\x00-\\x09\\x0b-\\x1f\\x7f-\\x9f${char(0x2028)}${char(0x2029)}]`)
/** Explicit embeddings, overrides and isolates (U+202A–U+202E, U+2066–U+2069). */
const BIDI_CONTROLS = new RegExp(`[${char(0x202a)}-${char(0x202e)}${char(0x2066)}-${char(0x2069)}]`)

/** The variables a text uses, in order. */
export function placeholdersOf(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!)
}

/** What a kind says about its variables: the allow-list, and how often one may appear in one text (B11-40). */
export type TemplateVariableRules = Pick<EmailTemplate, 'variables' | 'max_variable_uses'>

/**
 * The variables a text may hold, as its chips offer them: the kind's, without those the field
 * forbids (the purpose of a visit, free text a host types, is not a variable of a subject).
 */
export function fieldVariables(field: TemplateField, variables: readonly string[]): string[] {
  return variables.filter((name) => !field.forbidden_variables.includes(name))
}

/**
 * The first problem of a field's text, with the server's code and parameters, or null. An empty
 * text is no problem: it means the product's text.
 */
export function checkTemplateText(field: TemplateField, rules: TemplateVariableRules, value: string): FieldCodeEntry | null {
  const { variables, max_variable_uses: maxUses } = rules
  const text = normaliseTemplateText(value)
  if (text === '') return null
  if (textLength(text) > field.max_length) return { code: 'too_long', params: { max: field.max_length } }
  if (!field.multiline && /[\n\t]/.test(text)) return { code: 'line_breaks', params: {} }
  if (CONTROL.test(text)) return { code: 'control_characters', params: {} }
  if (BIDI_CONTROLS.test(text)) return { code: 'bidi_controls', params: {} }
  if (MARKUP.test(text)) return { code: 'markup_not_allowed', params: {} }
  if (BRACE.test(text.replace(PLACEHOLDER, ''))) return { code: 'invalid_placeholder', params: {} }
  const used = placeholdersOf(text)
  const unknown = used.find((name) => !variables.includes(name))
  if (unknown !== undefined) return { code: 'unknown_placeholder', params: { name: unknown, allowed: [...variables] } }
  const forbidden = used.find((name) => field.forbidden_variables.includes(name))
  if (forbidden !== undefined) return { code: 'placeholder_not_allowed', params: { name: forbidden } }
  const repeated = used.find((name) => used.filter((other) => other === name).length > maxUses)
  if (repeated !== undefined) return { code: 'placeholder_repeated', params: { name: repeated, max: maxUses } }
  const missing = field.required_variables.find((name) => !used.includes(name))
  if (missing !== undefined) return { code: 'placeholder_required', params: { name: missing } }
  return null
}

/** The codes whose `name` is one of the kind's variables (an unknown one has no label: it keeps its name). */
const NAMES_A_KNOWN_VARIABLE: ReadonlySet<string> = new Set(['placeholder_required', 'placeholder_not_allowed', 'placeholder_repeated'])

/** A problem in the UI language: the `errors:fieldCodes` text the server's code has in both catalogs. */
export function templateProblemMessage(problem: FieldCodeEntry, language: Language = currentLanguage()): string {
  // A variable of the kind (required, not allowed here, used too often) is named by its label ("Company"), as its chip names it.
  const named =
    NAMES_A_KNOWN_VARIABLE.has(problem.code) && typeof problem.params.name === 'string'
      ? { ...problem, params: { ...problem.params, name: variableLabel(problem.params.name, language) } }
      : problem
  return catalogText('errors', `fieldCodes.${named.code}`, { lng: language, ...fieldCodeValues(named, language) }) ?? problem.code
}

/**
 * A field's message of a refused request. The server's words name a variable as it is written
 * ("{purpose} cannot be used in this text."); the page names it as its chip does, in both languages, so
 * a refusal of the server reads like the same check made here. Any other code keeps the form's usual
 * message (`translateFieldError`), and a counted code without its count the server's words.
 */
export function serverProblemMessage(message: string, entry: FieldCodeEntry | undefined, language: Language = currentLanguage()): string {
  if (!entry || !NAMES_A_KNOWN_VARIABLE.has(entry.code) || typeof entry.params.name !== 'string') return message
  if (entry.code === 'placeholder_repeated' && typeof entry.params.max !== 'number') return message
  return templateProblemMessage(entry, language)
}

/** Every field's problem in the draft, by `ar.subject` / `en.intro`. */
export function draftProblems(template: EmailTemplate, draft: TemplateDraft): Partial<Record<TemplateFieldKey, FieldCodeEntry>> {
  const problems: Partial<Record<TemplateFieldKey, FieldCodeEntry>> = {}
  for (const language of TEMPLATE_LANGUAGES) {
    for (const field of template.fields) {
      const problem = checkTemplateText(field, template, draft[language][field.name] ?? '')
      if (problem) problems[fieldKey(language, field.name)] = problem
    }
  }
  return problems
}

/**
 * The saved texts that today's checks refuse: saved before a rule existed (B11-40). An e-mail leaves such
 * a text out and uses the default one (the backend's `usable_texts`), while the editor still gets it to
 * be corrected, so its problem is shown from the start and not only once it is typed in.
 */
export function refusedSavedTexts(template: EmailTemplate): TemplateFieldKey[] {
  const refused: TemplateFieldKey[] = []
  for (const field of template.fields) {
    for (const language of TEMPLATE_LANGUAGES) {
      if (checkTemplateText(field, template, field.override[language] ?? '')) refused.push(fieldKey(language, field.name))
    }
  }
  return refused
}

/* Request bodies ------------------------------------------------------------------------------------ */

/** Whether a field's draft differs from its saved text (both as the server stores them). */
export function isFieldChanged(field: TemplateField, language: Language, draft: TemplateDraft): boolean {
  return normaliseTemplateText(draft[language][field.name] ?? '') !== normaliseTemplateText(field.override[language] ?? '')
}

/**
 * PATCH /email-templates/{kind} with the fields that changed only (a field left out is unchanged; an
 * emptied one is null, back to the product's text), or null when nothing did.
 */
export function toTemplateUpdate(template: EmailTemplate, draft: TemplateDraft): EmailTemplateUpdate | null {
  const body: EmailTemplateUpdate = {}
  for (const language of TEMPLATE_LANGUAGES) {
    for (const field of template.fields) {
      if (!isFieldChanged(field, language, draft)) continue
      const text = normaliseTemplateText(draft[language][field.name] ?? '')
      body[language] = { ...body[language], [field.name]: text === '' ? null : text }
    }
  }
  return Object.keys(body).length > 0 ? body : null
}

/**
 * The preview's and the test's body: the leading language and the whole draft over the saved texts,
 * every field of the kind (an empty one null: the product's text).
 */
export function toPreviewRequest(template: EmailTemplate, draft: TemplateDraft, language: Language): EmailTemplatePreviewRequest {
  const body: EmailTemplatePreviewRequest = { language }
  for (const draftLanguage of TEMPLATE_LANGUAGES) {
    const texts: NonNullable<EmailTemplatePreviewRequest['ar']> = {}
    for (const field of template.fields) {
      const text = normaliseTemplateText(draft[draftLanguage][field.name] ?? '')
      texts[field.name] = text === '' ? null : text
    }
    body[draftLanguage] = texts
  }
  return body
}

/** How many of the kind's texts the company has changed (a language's field counts once). */
export function customisedCount(template: EmailTemplate): number {
  return template.fields.reduce((count, field) => count + TEMPLATE_LANGUAGES.filter((language) => field.override[language] !== null).length, 0)
}

/* Variables ----------------------------------------------------------------------------------------- */

/** `{name}` inserted in place of the selection (or at the caret); the caret goes after it. */
export function insertVariable(value: string, selectionStart: number | null, selectionEnd: number | null, name: string): { value: string; caret: number } {
  const token = `{${name}}`
  const start = Math.max(0, Math.min(selectionStart ?? value.length, value.length))
  const end = Math.max(start, Math.min(selectionEnd ?? start, value.length))
  return { value: `${value.slice(0, start)}${token}${value.slice(end)}`, caret: start + token.length }
}

/** A variable's name in the UI language ("Visitor name"), or the name itself for one the catalog does not know. */
export function variableLabel(name: string, language: Language = currentLanguage()): string {
  return catalogText('admin', `emailTemplates.variableNames.${name}`, { lng: language }) ?? name
}


/* The draft preview's subject and text version ------------------------------------------------------ */

export function otherLanguage(language: Language): Language {
  return language === 'ar' ? 'en' : 'ar'
}

/** A rule of the text version: a line of dashes or of equals signs (backend `templates/base.txt`). */
const RULE = /^(?:-{8,}|={8,})$/
/** The line that opens the footer there. */
const FOOTER_MARK = '--'
/** The subject's two languages are joined by this (backend `SUBJECT_SEPARATOR`). */
export const SUBJECT_SEPARATOR = ' | '
/** A value the e-mail isolates from its sentence: from an isolate initiator (U+2066 to U+2068) to its end (U+2069). */
const ISOLATED_VALUE = new RegExp(`[${char(0x2066)}-${char(0x2068)}][^${char(0x2069)}]*${char(0x2069)}?`, 'g')

/**
 * The language a line is written in, by its own letters: a value the e-mail isolates in it (a name,
 * a company, in either script) is left aside. Null when neither script leads (a rule, a time, a link
 * next to as many Arabic letters).
 */
export function lineLanguage(line: string): Language | null {
  const own = line.replace(ISOLATED_VALUE, '')
  const arabic = own.match(/\p{Script=Arabic}/gu)?.length ?? 0
  const latin = own.match(/\p{Script=Latin}/gu)?.length ?? 0
  if (arabic === latin) return null
  return arabic > latin ? 'ar' : 'en'
}

/** Lines of the text version that are in one language, in the order they are read. */
export interface PreviewSection {
  language: Language
  lines: string[]
}

/**
 * The language of every line of a bilingual e-mail's text version, from where the line stands:
 *
 * - the leading language's section runs from the top to the other language's title, its name between
 *   two rules (`templates/base.txt`); the other language's from there to the footer mark (`--`);
 * - in the footer, where the two languages follow each other without a mark, a line is in the
 *   language of its own letters (`lineLanguage`), or of the line before it;
 * - a text without that title (a layout this does not know) is read that way throughout.
 *
 * Counting each line's letters alone set an English line holding an Arabic name right to left
 * ("Hello سارة أحمد,", "Host: أمل حداد") and an Arabic one holding a Latin value left to right (UX
 * review L5).
 */
export function lineLanguages(lines: readonly string[], lead: Language): Language[] {
  const other = otherLanguage(lead)
  const isRule = (index: number) => RULE.test((lines[index] ?? '').trim())
  const title = lines.findIndex((line, index) => line.trim() === LANGUAGE_NAMES[other].name && isRule(index - 1) && isRule(index + 1))
  const footer = title < 0 ? -1 : lines.findLastIndex((line, index) => index > title + 1 && line.trim() === FOOTER_MARK)
  let current = lead
  return lines.map((line, index) => {
    if (title >= 0 && (footer < 0 || index <= footer)) {
      // The rule above its title belongs to the other language's section; the footer mark to neither (the lead's).
      if (index === footer) return lead
      return index < title - 1 ? lead : other
    }
    current = lineLanguage(line) ?? current
    return current
  })
}

/** The text version as its language sections: each one's lines are set in its direction and carry its `lang`. */
export function previewTextSections(text: string, lead: Language): PreviewSection[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop()
  const languages = lineLanguages(lines, lead)
  const sections: PreviewSection[] = []
  lines.forEach((line, index) => {
    const language = languages[index]!
    const last = sections.at(-1)
    if (last && last.language === language) last.lines.push(line)
    else sections.push({ language, lines: [line] })
  })
  return sections
}

/**
 * The subject's two languages, the leading one first, when it has the one separator that joins them;
 * otherwise the whole subject in the leading language (a company's subject may hold the separator itself).
 */
export function previewSubjectParts(subject: string, lead: Language): { language: Language; text: string }[] {
  const parts = subject.split(SUBJECT_SEPARATOR)
  if (parts.length !== 2) return [{ language: lead, text: subject }]
  return [
    { language: lead, text: parts[0]! },
    { language: otherLanguage(lead), text: parts[1]! },
  ]
}

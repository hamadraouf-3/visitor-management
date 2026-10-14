import type { EmailTemplate, EmailTemplateKind } from '../../types/api'

/** E-mail texts as the API answers them (tests only): the product's texts, nothing changed. */

const VISITOR_VARIABLES = ['visitor_name', 'company', 'host_name', 'date', 'time', 'timezone', 'department', 'purpose']
const HOST_VARIABLES = ['host_name', 'visitor_name', 'visitor_company', 'company', 'date', 'time', 'timezone', 'purpose']

type Field = EmailTemplate['fields'][number]

function field(name: Field['name'], multiline: boolean, max: number, ar: string, en: string, required: string[] = []): Field {
  return {
    name,
    multiline,
    max_length: max,
    required_variables: required,
    // The purpose of a visit is not a variable of a subject (B11-40).
    forbidden_variables: name === 'subject' ? ['purpose'] : [],
    default: { ar, en },
    override: { ar: null, en: null },
  }
}

export function makeEmailTemplate(kind: EmailTemplateKind = 'VISITOR_INVITATION', overrides: Partial<EmailTemplate> = {}): EmailTemplate {
  const host = kind === 'HOST_ARRIVAL'
  const fields: Field[] = [
    field('subject', false, 150, host ? 'وصل {visitor_name}' : 'زيارتك إلى {company} يوم {date}', host ? '{visitor_name} has arrived' : 'Your visit to {company} on {date}', [
      host ? 'visitor_name' : 'company',
    ]),
    field('heading', false, 150, 'زيارتك إلى {company}', 'Your visit to {company}'),
    field('greeting', false, 150, host ? 'مرحبًا {host_name}،' : 'مرحبًا {visitor_name}،', host ? 'Hello {host_name},' : 'Hello {visitor_name},'),
    field('intro', true, 1000, 'تلقّيت دعوةً من {host_name} لزيارة {company}.', '{host_name} has invited you to visit {company}.'),
  ]
  if (kind === 'VISITOR_INVITATION') fields.push(field('button', false, 40, 'عرض بطاقة الزيارة', 'Open my visitor pass'))
  fields.push(field('closing', true, 1000, '', ''), field('footer_note', true, 300, '', ''))
  return { kind, variables: host ? HOST_VARIABLES : VISITOR_VARIABLES, max_variable_uses: 3, updated_at: null, fields, ...overrides }
}

/** The same template with company texts set: `{ en: { subject: '…' } }`. */
export function withOverrides(template: EmailTemplate, texts: Partial<Record<'ar' | 'en', Partial<Record<Field['name'], string>>>>, updatedAt = '2026-10-05T07:00:00Z'): EmailTemplate {
  return {
    ...template,
    updated_at: updatedAt,
    fields: template.fields.map((item) => ({
      ...item,
      override: { ar: texts.ar?.[item.name] ?? item.override.ar, en: texts.en?.[item.name] ?? item.override.en },
    })),
  }
}

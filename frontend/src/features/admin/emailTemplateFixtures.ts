import type { EmailTemplate, EmailTemplateKind } from '../../types/api'

/** E-mail texts as the API answers them (tests only): the product's texts, nothing changed. */

const VISITOR_VARIABLES = ['visitor_name', 'company', 'host_name', 'date', 'time', 'timezone', 'department', 'purpose']
const HOST_VARIABLES = ['host_name', 'visitor_name', 'visitor_company', 'company', 'date', 'time', 'timezone', 'purpose']
/** The host's visit e-mails (Phase 14): the arrival's variables and the department. */
const HOST_VISIT_VARIABLES = ['host_name', 'visitor_name', 'visitor_company', 'company', 'date', 'time', 'timezone', 'department', 'purpose']

/** The product's subject, heading and intro of each kind as the fixture writes them: [ar, en]. */
const TEXTS: Record<EmailTemplateKind, { subject: [string, string]; heading: [string, string]; intro: [string, string] }> = {
  VISITOR_INVITATION: {
    subject: ['زيارتك إلى {company} يوم {date}', 'Your visit to {company} on {date}'],
    heading: ['زيارتك إلى {company}', 'Your visit to {company}'],
    intro: ['تلقّيت دعوةً من {host_name} لزيارة {company}.', '{host_name} has invited you to visit {company}.'],
  },
  VISIT_RESCHEDULED: {
    subject: ['زيارتك إلى {company} يوم {date}', 'Your visit to {company} on {date}'],
    heading: ['زيارتك إلى {company}', 'Your visit to {company}'],
    intro: ['تلقّيت دعوةً من {host_name} لزيارة {company}.', '{host_name} has invited you to visit {company}.'],
  },
  VISIT_CANCELLED: {
    subject: ['زيارتك إلى {company} يوم {date}', 'Your visit to {company} on {date}'],
    heading: ['زيارتك إلى {company}', 'Your visit to {company}'],
    intro: ['تلقّيت دعوةً من {host_name} لزيارة {company}.', '{host_name} has invited you to visit {company}.'],
  },
  HOST_ARRIVAL: {
    subject: ['وصل {visitor_name}', '{visitor_name} has arrived'],
    heading: ['زيارتك إلى {company}', 'Your visit to {company}'],
    intro: ['تلقّيت دعوةً من {host_name} لزيارة {company}.', '{host_name} has invited you to visit {company}.'],
  },
  HOST_VISIT_SCHEDULED: {
    subject: ['زيارة: {visitor_name} يوم {date}', 'Visit: {visitor_name} on {date}'],
    heading: ['لديك زيارة', 'You have a visit'],
    intro: ['سيزورك {visitor_name} يوم {date}.', '{visitor_name} is visiting you on {date}.'],
  },
  HOST_VISIT_RESCHEDULED: {
    subject: ['تغيّر موعد زيارة {visitor_name}', 'Visit rescheduled: {visitor_name}'],
    heading: ['تغيّر موعد الزيارة', 'The visit has been rescheduled'],
    intro: ['تغيّر موعد زيارة {visitor_name}.', 'The visit of {visitor_name} has been rescheduled.'],
  },
  HOST_VISIT_CANCELLED: {
    subject: ['أُلغيت زيارة {visitor_name}', 'Visit cancelled: {visitor_name}'],
    heading: ['أُلغيت الزيارة', 'The visit has been cancelled'],
    intro: ['أُلغيت زيارة {visitor_name}.', 'The visit of {visitor_name} has been cancelled.'],
  },
}

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
  // Every e-mail to the host names the visitor in its subject; every one to the visitor the company (B11-25).
  const host = kind.startsWith('HOST_')
  const texts = TEXTS[kind]
  const fields: Field[] = [
    field('subject', false, 150, ...texts.subject, [host ? 'visitor_name' : 'company']),
    field('heading', false, 150, ...texts.heading),
    field('greeting', false, 150, host ? 'مرحبًا {host_name}،' : 'مرحبًا {visitor_name}،', host ? 'Hello {host_name},' : 'Hello {visitor_name},'),
    field('intro', true, 1000, ...texts.intro),
  ]
  if (kind === 'VISITOR_INVITATION') fields.push(field('button', false, 40, 'عرض بطاقة الزيارة', 'Open my visitor pass'))
  fields.push(field('closing', true, 1000, '', ''), field('footer_note', true, 300, '', ''))
  const variables = kind === 'HOST_ARRIVAL' ? HOST_VARIABLES : host ? HOST_VISIT_VARIABLES : VISITOR_VARIABLES
  return { kind, variables, max_variable_uses: 3, updated_at: null, fields, ...overrides }
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

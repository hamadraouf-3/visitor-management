import { CalendarClock, CalendarX, ChevronRight, DoorOpen, Mail, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Badge } from '../../components/ui/Badge'
import { Card } from '../../components/ui/Card'
import { IconTile } from '../../components/ui/IconTile'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { MetaLine } from '../../components/ui/MetaLine'
import { PageHeader } from '../../components/ui/PageHeader'
import { PageSpinner } from '../../components/ui/Spinner'
import type { EmailTemplate, EmailTemplateKind } from '../../types/api'
import { formatDate } from '../../utils/datetime'
import { DATA_SEPARATOR } from '../../utils/text'
import { customisedCount, templateRecipient } from './emailTemplateForm'
import { useEmailTemplatesSource } from './emailTemplatesSource'
import { useEmailTemplates } from './queries'

/** The icon of each kind's tile (decorative: the name says it). */
const KIND_ICONS: Record<EmailTemplateKind, LucideIcon> = {
  VISITOR_INVITATION: Mail,
  VISIT_RESCHEDULED: CalendarClock,
  VISIT_CANCELLED: CalendarX,
  HOST_ARRIVAL: DoorOpen,
}

function TemplateRow({ template }: { template: EmailTemplate }) {
  const { t } = useTranslation('admin')
  const source = useEmailTemplatesSource()
  const changed = customisedCount(template)
  const kindName = t(`emailTemplates.kinds.${template.kind}`)
  return (
    <li className="relative flex items-center gap-4 px-4 py-4 transition-colors has-[a:hover]:bg-surface-sunken sm:px-5">
      <IconTile icon={KIND_ICONS[template.kind]} tone={changed > 0 ? 'accent' : 'neutral'} />
      <div className="min-w-0 flex-1">
        <h2 className="text-[0.96875rem] leading-snug font-semibold">
          {/* The whole row is the link's target (its ::after covers the row). */}
          <Link to={source.templatePath(template.kind)} className="text-fg after:absolute after:inset-0 hover:text-accent-text hover:underline">
            {kindName}
          </Link>
        </h2>
        <MetaLine
          stackOnPhones
          className="mt-1 text-meta text-fg-muted"
          items={[
            t(`emailTemplates.recipients.${templateRecipient(template.kind)}`),
            template.updated_at ? t('emailTemplates.changedAt', { date: formatDate(template.updated_at, source.timeZone) }) : null,
          ]}
        />
      </div>
      {changed > 0 ? <Badge tone="accent">{t('emailTemplates.customised', { count: changed })}</Badge> : <Badge tone="neutral">{t('emailTemplates.productTexts')}</Badge>}
      <ChevronRight aria-hidden="true" className="mirror-rtl size-5 shrink-0 text-fg-muted" />
    </li>
  )
}

/**
 * The four e-mails whose words a company may change (B11-20), each to its editor: the company's
 * own list for its administrator (`/admin/email-templates`), and a company's list for the platform
 * owner (Phase 12), whose way back above the title names the company.
 */
export function EmailTemplateList() {
  const { t } = useTranslation('admin')
  const source = useEmailTemplatesSource()
  const templates = useEmailTemplates()

  return (
    <div className="max-w-4xl">
      <PageHeader
        title={t('emailTemplates.title')}
        back={source.listBack}
        leading={source.owner?.leading}
        subject={source.owner?.name}
        documentTitle={source.owner ? [t('emailTemplates.title'), source.owner.name].join(DATA_SEPARATOR) : undefined}
      />
      {templates.isPending ? (
        <PageSpinner />
      ) : templates.isError ? (
        <LoadErrorAlert title={t('emailTemplates.loadError')} error={templates.error} onRetry={() => void templates.refetch()} />
      ) : (
        <Card flush>
          <ul aria-label={t('emailTemplates.listLabel')} className="divide-y divide-border-subtle">
            {templates.data.map((template) => (
              <TemplateRow key={template.kind} template={template} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

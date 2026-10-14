import { Bot, ShieldCheck, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Avatar } from '../../components/ui/Avatar'
import { Badge } from '../../components/ui/Badge'
import { IconTile } from '../../components/ui/IconTile'
import { withParts } from '../../i18n/withParts'
import type { AuditLog } from '../../types/api'
import { cn } from '../../utils/cn'
import { auditEventQualifier } from './auditFormat'
import { auditActionLabel, auditEntityDescription, auditEntityLink, auditEntityLinkText, isFailureEvent, isPlatformSourced } from './auditLabels'

/**
 * The actor's name; "Platform owner" for what the platform owner did to the company (Phase 11: no
 * actor, `metadata.source = "platform"`; the platform account's name is not disclosed to companies);
 * "Command line" or "Demo data seed" for what an operator did at the server; "System" for other
 * events without a person (no-show marking, e-mail delivery).
 */
export function AuditActor({ log }: { log: Pick<AuditLog, 'actor' | 'metadata'> }) {
  const { t } = useTranslation('admin')
  if (log.actor) return <span className="break-words">{log.actor.full_name}</span>
  if (isPlatformSourced(log)) return <span data-platform-actor="" className="font-medium text-fg">{t('audit.platformActor')}</span>
  // An operator at the server: the command line (`create-admin`, `create-platform-admin`) or a seed command (B11-36).
  if (log.metadata.source === 'cli') return <span className="text-fg-muted">{t('audit.values.cli')}</span>
  if (log.metadata.source === 'seed') return <span className="text-fg-muted">{t('audit.values.seed')}</span>
  return <span className="text-fg-muted">{t('audit.systemActor')}</span>
}

/**
 * Who performed an event as direction C's person cell: the initials tile and the name, or a
 * neutral tile for the system and anonymous requests. The tiles are decorative.
 */
export function AuditActorCell({ log, className }: { log: Pick<AuditLog, 'actor' | 'metadata'>; className?: string }) {
  const tile = log.actor ? (
    <Avatar name={log.actor.full_name} size="sm" />
  ) : isPlatformSourced(log) ? (
    <IconTile icon={ShieldCheck} tone="accent" size="sm" />
  ) : (
    <IconTile icon={Bot} size="sm" />
  )
  return (
    <span className={cn('flex min-w-0 items-center gap-2.5', className)}>
      {tile}
      <span className="min-w-0 text-sm">
        <AuditActor log={log} />
      </span>
    </span>
  )
}

/**
 * The event's name: its action label, a qualifier from the metadata (a scan's outcome, why a
 * sign-in failed) as a chip, and, for failures and denials, "Failure or denial:" for assistive
 * technology (with a warning mark unless the row's icon tile already shows one).
 */
export function AuditEventTitle({ log, headingLevel, showFailureMark = true, className }: { log: AuditLog; headingLevel?: 'h3'; showFailureMark?: boolean; className?: string }) {
  const { t } = useTranslation('admin')
  const failure = isFailureEvent(log)
  const qualifier = auditEventQualifier(log)
  const Title = headingLevel ?? 'p'
  return (
    <Title className={cn('flex flex-wrap items-center gap-x-2 gap-y-1', className)}>
      {failure && (
        <>
          {showFailureMark && <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warning-solid" />}
          <span className="sr-only">{t('audit.failure')}</span>
        </>
      )}
      <span>{auditActionLabel(log.action)}</span>
      {qualifier && (
        <Badge tone={failure ? 'warning' : 'neutral'} className="font-medium">
          {qualifier}
        </Badge>
      )}
    </Title>
  )
}

/**
 * What the event concerns, in words, with a link where that can be opened ("Visit · Open visit").
 * Raw IDs are left to the event's details. Null for an event about nothing in particular. With a
 * `name` (the platform owner's trail knows which administrator a row is about) the line says it:
 * "User: Nadia Haddad".
 */
export function AuditEventConcerns({ log, className, links = true, name = null }: { log: AuditLog; className?: string; links?: boolean; name?: string | null }) {
  const { t } = useTranslation('admin')
  const link = links ? auditEntityLink(log) : null
  if (!log.entity_type) return null
  const entity = auditEntityDescription(log)
  return (
    <span className={cn('flex flex-wrap items-center gap-x-2', className)}>
      {/* One sentence of the catalog around the name, which is isolated: an Arabic name in the English line keeps its place. */}
      <span data-audit-concerns="">
        {name && entity ? withParts((markers) => t('audit.entityNamed', { entity, name: markers.name }), { name: <bdi>{name}</bdi> }) : entity}
      </span>
      {link && (
        // At least 24 px tall (WCAG 2.5.8), 44 px on touch screens without changing the line height (13 px text: 18 + 2 × 14).
        <Link to={link} className="relative z-10 inline-flex min-h-6 items-center font-medium text-accent-text hover:underline pointer-coarse:-my-3.5 pointer-coarse:py-3.5">
          {auditEntityLinkText(log.entity_type)}
        </Link>
      )}
    </span>
  )
}

/**
 * The event in words: its name and what it concerns. Every text comes from data and is rendered as
 * text, never as markup.
 */
export function AuditEventSummary({
  log,
  headingLevel,
  showFailureMark = true,
  entityLinks = true,
  entityName = null,
}: {
  log: AuditLog
  headingLevel?: 'h3'
  showFailureMark?: boolean
  /** Links to what the event concerns (a company's own pages); off in the platform owner's trail. */
  entityLinks?: boolean
  /** The name of what the event concerns, when the caller knows it. */
  entityName?: string | null
}) {
  return (
    <div className="min-w-0">
      <AuditEventTitle log={log} headingLevel={headingLevel} showFailureMark={showFailureMark} className="text-[0.90625rem] leading-snug font-semibold text-fg" />
      <AuditEventConcerns log={log} links={entityLinks} name={entityName} className="mt-0.5 text-meta text-fg-muted" />
    </div>
  )
}

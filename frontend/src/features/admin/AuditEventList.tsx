import { ChevronDown } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { DescriptionList } from '../../components/ui/DescriptionList'
import { IconTile } from '../../components/ui/IconTile'
import type { AuditLog } from '../../types/api'
import { cn } from '../../utils/cn'
import { formatClockTime, formatDate, formatDateAtClockTime, formatTimeZoneName } from '../../utils/datetime'
import { AuditActor, AuditActorCell, AuditEventSummary } from './AuditEventSummary'
import { metadataEntries, metadataJson } from './auditFormat'
import { auditActionLabel, auditEntityLabel } from './auditLabels'
import { auditEventVisual } from './auditVisuals'

const MONO = 'font-mono text-xs break-all select-all'

/**
 * A row's layout. Phones stack the event over when, about which company and by whom; from the
 * breakpoint on, the row is a line of columns under a header row (time, event, by, the details
 * button), every width fixed but the event's. Each cell is placed explicitly: the DOM reads the
 * event first, then when and by whom.
 *
 * - `plain` (a company's own log): columns from `md`; from `xl` the time column holds an Arabic date
 *   on one line.
 * - `withCompany` (the platform owner's trail, Phase 11: the company an event concerns between the
 *   event and its actor): columns only from `xl`. Five columns do not fit the 678 to 830 px a
 *   tablet or a small laptop beside the sidebar leaves: with fixed company and actor tracks the
 *   event kept 38 to 114 px and its title was drawn over the company (UX review H1). From `xl` the
 *   event keeps at least 12rem and the company and the actor share what is left.
 */
const LAYOUTS = {
  plain: {
    columns: 'md:grid-cols-[9.5rem_minmax(0,1fr)_minmax(0,11rem)_7.5rem] xl:grid-cols-[12rem_minmax(0,1fr)_minmax(0,13rem)_7.5rem]',
    header: 'md:grid md:gap-x-4',
    row: 'md:items-center md:gap-x-4',
    event: 'md:col-span-1 md:col-start-2 md:row-start-1 md:items-center',
    time: 'md:col-start-1 md:row-start-1 md:flex-col md:gap-0 md:ps-0',
    company: '',
    actor: 'row-start-3 md:col-start-3 md:row-start-1 md:ps-0',
    details: 'md:col-start-4 md:row-span-1 md:row-start-1',
  },
  withCompany: {
    columns: 'xl:grid-cols-[12rem_minmax(12rem,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_7.5rem]',
    header: 'xl:grid xl:gap-x-4',
    row: 'xl:items-center xl:gap-x-4',
    event: 'xl:col-span-1 xl:col-start-2 xl:row-start-1 xl:items-center',
    time: 'xl:col-start-1 xl:row-start-1 xl:flex-col xl:gap-0 xl:ps-0',
    company: 'xl:col-start-3 xl:row-start-1 xl:ps-0',
    actor: 'row-start-4 xl:col-start-4 xl:row-start-1 xl:ps-0',
    details: 'xl:col-start-5 xl:row-span-1 xl:row-start-1',
  },
} as const

/** The event's metadata: labelled values, then the raw JSON. Rendered as text only (never markup). */
export function AuditMetadata({ metadata }: { metadata: Record<string, unknown> }) {
  const { t } = useTranslation('admin')
  const entries = metadataEntries(metadata)
  if (entries.length === 0) return <p className="text-sm text-fg-muted">{t('audit.none')}</p>
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[minmax(8rem,auto)_minmax(0,1fr)]">
        {entries.map((entry) => (
          <div key={entry.key} className="contents">
            <dt className="text-sm font-medium text-fg-muted">{entry.label}</dt>
            <dd className="text-sm break-words text-fg">{entry.value}</dd>
          </div>
        ))}
      </dl>
      <details className="text-sm">
        <summary className="inline-flex min-h-6 cursor-pointer items-center font-semibold text-accent-text pointer-coarse:min-h-11">{t('audit.details.raw')}</summary>
        {/*
          JSON reads left to right in either language: inheriting the Arabic page's direction put each
          line's brace, comma and colon at the wrong end. At its full height, wrapping inside its box: a
          box that scrolled on its own needed a tab stop (axe `scrollable-region-focusable`; UX review M7).
        */}
        <pre
          dir="ltr"
          data-audit-raw=""
          className="mt-2 rounded-control border border-border-subtle bg-surface-sunken p-3 font-mono text-xs wrap-anywhere whitespace-pre-wrap text-fg"
        >
          {metadataJson(metadata)}
        </pre>
      </details>
    </div>
  )
}

function AuditEventDetails({ log, timeZone, id, entityName }: { log: AuditLog; timeZone: string; id: string; entityName: string | null }) {
  const { t } = useTranslation('admin')
  return (
    <div id={id} className="mt-4 flex flex-col gap-5 rounded-control border border-border-subtle bg-surface-sunken p-4 sm:p-5">
      <DescriptionList
        items={[
          {
            term: t('audit.details.time'),
            description: (
              <>
                <span className="block">
                  {t('audit.details.timeValue', {
                    when: formatDateAtClockTime(log.created_at, timeZone),
                    zone: formatTimeZoneName(timeZone, log.created_at),
                  })}
                </span>
                <span className={cn('block text-fg-muted', MONO)}>{log.created_at}</span>
              </>
            ),
          },
          { term: t('audit.details.sequence'), description: <span className="font-numeric tabular-nums">{log.seq}</span> },
          {
            term: t('audit.details.performedBy'),
            description: (
              <>
                <AuditActor log={log} />
                {log.actor && <span className={cn('block text-fg-muted', MONO)}>{log.actor.id}</span>}
              </>
            ),
          },
          {
            term: t('audit.details.record'),
            description: log.entity_type ? (
              <>
                <span className="block">{auditEntityLabel(log.entity_type)}</span>
                {entityName && (
                  <bdi data-audit-entity-name="" className="block font-medium break-words">
                    {entityName}
                  </bdi>
                )}
                {log.entity_id && <span className={cn('block text-fg-muted', MONO)}>{log.entity_id}</span>}
              </>
            ) : (
              <span className="text-fg-muted">—</span>
            ),
          },
          {
            term: t('audit.details.ip'),
            description: log.ip_address ? (
              <span dir="ltr" className={MONO}>
                {log.ip_address}
              </span>
            ) : (
              <span className="text-fg-muted">{t('audit.details.notRecorded')}</span>
            ),
          },
          {
            term: t('audit.details.requestId'),
            description: log.request_id ? (
              <span dir="ltr" className={MONO}>
                {log.request_id}
              </span>
            ) : (
              <span className="text-fg-muted">—</span>
            ),
          },
          {
            term: t('audit.details.userAgent'),
            wide: true,
            description: log.user_agent ? (
              <span dir="ltr" className="text-xs break-all">
                {log.user_agent}
              </span>
            ) : (
              <span className="text-fg-muted">{t('audit.details.notRecorded')}</span>
            ),
          },
        ]}
      />
      {/*
        A label, not a heading: the rows sit directly under the page's h1, and the Details button names the
        region. A group, not a <section>: a labelled section is a landmark, and two open events would give the
        page two landmarks with the same name (axe `landmark-unique`).
      */}
      <div role="group" aria-labelledby={`${id}-metadata`} className="border-t border-border-subtle pt-4">
        <p id={`${id}-metadata`} className="mb-2 text-sm font-semibold text-fg">
          {t('audit.details.recorded')}
        </p>
        <AuditMetadata metadata={log.metadata} />
      </div>
    </div>
  )
}

interface AuditEventRowProps<L extends AuditLog> {
  log: L
  timeZone: string
  renderCompany?: (log: L) => ReactNode
  entityLinks: boolean
  entityName: string | null
}

function AuditEventRow<L extends AuditLog>({ log, timeZone, renderCompany: company, entityLinks, entityName }: AuditEventRowProps<L>) {
  const { t } = useTranslation(['admin', 'common'])
  const [open, setOpen] = useState(false)
  const detailsId = `audit-event-${log.id}`
  const date = formatDate(log.created_at, timeZone)
  const clock = formatClockTime(log.created_at, timeZone)
  const visual = auditEventVisual(log)
  const layout = LAYOUTS[company ? 'withCompany' : 'plain']
  return (
    <li className="px-4 py-3.5 sm:px-5">
      <div data-audit-row="" className={cn('grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5', layout.row, layout.columns)}>
        {/* The event: its kind's tile, its name and what it concerns. */}
        <div data-audit-cell="event" className={cn('col-span-2 flex min-w-0 items-start gap-3', layout.event)}>
          <IconTile icon={visual.icon} tone={visual.tone} mirrorIcon={visual.mirror} />
          <AuditEventSummary log={log} showFailureMark={false} entityLinks={entityLinks} entityName={entityName} />
        </div>
        {/* When: the time to the second over the date (one line on phones, under the event). */}
        <time data-audit-cell="time" dateTime={log.created_at} className={cn('col-start-1 row-start-2 flex flex-wrap items-baseline gap-x-2 ps-12', layout.time)}>
          <span className="font-numeric text-sm font-medium text-fg tabular-nums">{clock}</span>
          <span className="text-[0.78125rem] text-fg-muted">{date}</span>
        </time>
        {company && (
          <p data-audit-cell="company" className={cn('col-start-1 row-start-3 min-w-0 ps-12 text-sm break-words text-fg-secondary', layout.company)}>
            {company(log)}
          </p>
        )}
        <p data-audit-cell="actor" className={cn('col-start-1 min-w-0 ps-12', layout.actor)}>
          <span className="sr-only">{t('audit.by')} </span>
          <AuditActorCell log={log} />
        </p>
        <button
          type="button"
          data-audit-cell="details"
          aria-expanded={open}
          aria-controls={open ? detailsId : undefined}
          aria-label={t('audit.detailsFor', { event: auditActionLabel(log.action), time: t('common:dates.dateTime', { date, time: clock }) })}
          onClick={() => setOpen((current) => !current)}
          className={cn(
            'col-start-2 row-span-2 row-start-2 inline-flex min-h-9 items-center gap-1 self-center justify-self-end rounded-control px-2.5 text-sm font-semibold text-accent-text hover:bg-surface-muted pointer-coarse:min-h-11',
            layout.details,
          )}
        >
          {t('audit.detailsButton')}
          <ChevronDown aria-hidden="true" className={cn('size-4 transition-transform', open && 'rotate-180')} />
        </button>
      </div>
      {open && <AuditEventDetails log={log} timeZone={timeZone} id={detailsId} entityName={entityName} />}
    </li>
  )
}

export interface AuditEventListProps<L extends AuditLog = AuditLog> {
  events: L[]
  timeZone: string
  /**
   * The company an event concerns, as a column of its own between the event and its actor: the
   * platform owner's trail (Phase 11), whose rows name a company.
   */
  renderCompany?: (log: L) => ReactNode
  /** The header of the company column. */
  companyHeader?: string
  /** Links from an event to what it concerns (a company's own pages); off in the platform owner's trail. */
  entityLinks?: boolean
  /**
   * The name of what an event concerns, when the caller knows it (the platform owner's trail names
   * the administrator a "User created" row is about); null leaves the kind of record alone ("User").
   */
  entityName?: (log: L) => string | null
  /** The list's accessible name; the company audit log's by default. */
  label?: string
}

/** Audit events, newest first (by `seq`), as direction C's table card; each row expands to everything that was recorded. */
export function AuditEventList<L extends AuditLog = AuditLog>({
  events,
  timeZone,
  renderCompany: company,
  companyHeader,
  entityLinks = true,
  entityName,
  label,
}: AuditEventListProps<L>) {
  const { t } = useTranslation('admin')
  const layout = LAYOUTS[company ? 'withCompany' : 'plain']
  const headers = company
    ? [t('audit.columns.time'), t('audit.columns.event'), companyHeader ?? '', t('audit.columns.by'), '']
    : [t('audit.columns.time'), t('audit.columns.event'), t('audit.columns.by'), '']
  return (
    <div className="rounded-card border border-border bg-surface">
      <div
        aria-hidden="true"
        data-audit-header=""
        className={cn('hidden rounded-t-card border-b border-border-subtle bg-surface-sunken px-5 py-3', layout.header, layout.columns)}
      >
        {headers.map((header, index) => (
          <span key={index} className="text-[0.78125rem] font-semibold text-fg-muted">
            {header}
          </span>
        ))}
      </div>
      <ol aria-label={label ?? t('audit.listLabel')} className="divide-y divide-border-subtle">
        {events.map((log) => (
          <AuditEventRow key={log.id} log={log} timeZone={timeZone} renderCompany={company} entityLinks={entityLinks} entityName={entityName?.(log) ?? null} />
        ))}
      </ol>
    </div>
  )
}

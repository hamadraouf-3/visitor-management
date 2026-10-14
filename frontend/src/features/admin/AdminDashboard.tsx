import { CalendarDays, ChevronRight, Contact, DoorOpen, FileClock, ScrollText, Settings, UserPlus } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useCompanySettings } from '../../api/queries'
import { ButtonLink } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { IconTile } from '../../components/ui/IconTile'
import { RowList } from '../../components/ui/ListRow'
import { LiveIndicator } from '../../components/ui/LiveIndicator'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { MetaLine } from '../../components/ui/MetaLine'
import { PageHeader } from '../../components/ui/PageHeader'
import { PageSpinner } from '../../components/ui/Spinner'
import { StatGrid, StatTile } from '../../components/ui/StatTile'
import { useNow } from '../../hooks/useNow'
import { isLanguage, LANGUAGE_NAMES } from '../../i18n'
import { paths } from '../../paths'
import type { AdminDashboard as AdminDashboardData, AuditLog, Me, Role } from '../../types/api'
import { companyToday, formatDate, formatRelativeDateTime, formatTime, formatTimeZoneName } from '../../utils/datetime'
import { formatCount } from '../../utils/number'
import { AuditActor, AuditEventConcerns, AuditEventTitle } from './AuditEventSummary'
import { auditEventVisual } from './auditVisuals'
import { historyLinkForDay, usersLinkForRole } from './adminLinks'
import { useAdminDashboard } from './queries'
import { ROLE_VISUALS } from './roleVisuals'

type Counts = AdminDashboardData['counts']

/**
 * One activity row (direction C): the event's kind as a tile, its name and what it concerns, and
 * when and by whom. From `sm` the time and the actor stand at the row's end, one over the other, so
 * a row is two lines; on phones they are a third line under the event. One DOM for both.
 */
function ActivityRow({ log, timeZone, now }: { log: AuditLog; timeZone: string; now: number }) {
  const { t } = useTranslation('admin')
  const visual = auditEventVisual(log)
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:gap-x-4 sm:px-5">
      <IconTile icon={visual.icon} tone={visual.tone} mirrorIcon={visual.mirror} className="row-span-2 sm:row-span-1" />
      <div className="min-w-0">
        <AuditEventTitle log={log} showFailureMark={false} className="text-[0.90625rem] leading-snug font-semibold text-fg" />
        <AuditEventConcerns log={log} className="mt-0.5 text-meta text-fg-secondary" />
      </div>
      <p className="col-start-2 flex flex-wrap items-center gap-x-2 text-[0.78125rem] leading-snug text-fg-muted sm:col-start-3 sm:row-start-1 sm:flex-col sm:items-end sm:gap-0.5 sm:text-end">
        <time dateTime={log.created_at} className="font-medium text-fg-secondary tabular-nums">
          {formatRelativeDateTime(log.created_at, timeZone, now)}
        </time>
        <span aria-hidden="true" className="size-1 shrink-0 rounded-full bg-border-strong sm:hidden" />
        <span className="max-w-48 break-words">
          <span className="sr-only">{t('audit.by')} </span>
          <AuditActor log={log} />
        </span>
      </p>
    </li>
  )
}

/** The latest audit events as direction C's activity list. */
function RecentAudit({ events, timeZone, now }: { events: AdminDashboardData['recent_audit']; timeZone: string; now: number }) {
  const { t } = useTranslation('admin')
  if (events.length === 0) {
    return <EmptyState icon={ScrollText} title={t('dashboard.audit.emptyTitle')} headingLevel="h3" className="rounded-none border-0 py-10" />
  }
  return (
    <RowList label={t('dashboard.audit.listLabel')}>
      {events.map((log) => (
        <ActivityRow key={log.id} log={log} timeZone={timeZone} now={now} />
      ))}
    </RowList>
  )
}

/**
 * The settings that apply to everyone, as facts (the company's default language, its time zone,
 * walk-ins, the visitor pass window), with the way to change them. Read from GET /company/settings;
 * left out until it answers.
 */
function CompanyCard({ now }: { now: number }) {
  const { t } = useTranslation('admin')
  const settings = useCompanySettings().data
  if (!settings) return null
  const language = isLanguage(settings.default_language) ? settings.default_language : 'ar'
  const facts: { term: string; value: ReactNode }[] = [
    { term: t('settings.language.label'), value: <span lang={language}>{LANGUAGE_NAMES[language].name}</span> },
    { term: t('settings.timezone.label'), value: formatTimeZoneName(settings.timezone, now) },
    { term: t('dashboard.company.walkIns'), value: settings.allow_walk_ins ? t('dashboard.company.allowed') : t('dashboard.company.notAllowed') },
    {
      term: t('dashboard.company.passWindow'),
      value: t('dashboard.company.passWindowValue', { before: formatCount(settings.pass_grace_before_minutes), after: formatCount(settings.pass_grace_after_minutes) }),
    },
  ]
  return (
    <Card
      title={t('settings.title')}
      titleId="dashboard-company"
      actions={
        <ButtonLink to={paths.adminSettings} variant="secondary" size="sm" icon={<Settings aria-hidden="true" />}>
          {t('dashboard.company.edit')}
        </ButtonLink>
      }
      flush
    >
      <dl className="divide-y divide-border-subtle px-4 py-1 sm:px-5">
        {facts.map((fact) => (
          <div key={fact.term} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-3">
            <dt className="text-meta text-fg-muted">{fact.term}</dt>
            <dd className="ms-auto text-sm font-semibold break-words text-fg tabular-nums sm:text-end">{fact.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}

const ACCOUNT_ROWS: readonly { role: Role; count: keyof Counts; label: 'employees' | 'reception' | 'management' | 'admins' }[] = [
  { role: 'EMPLOYEE', count: 'employees', label: 'employees' },
  { role: 'RECEPTIONIST', count: 'receptionists', label: 'reception' },
  { role: 'MANAGEMENT', count: 'management', label: 'management' },
  { role: 'SYSTEM_ADMIN', count: 'admins', label: 'admins' },
]

/** Active accounts by role, each row a link to the users who hold it (a person with several roles counts under each). */
function AccountsCard({ counts }: { counts: Counts }) {
  const { t } = useTranslation('admin')
  return (
    <Card title={t('dashboard.accounts.title')} titleId="dashboard-accounts" flush>
      <ul className="divide-y divide-border-subtle">
        {ACCOUNT_ROWS.map(({ role, count, label }) => (
          <li key={role} className="last:*:rounded-b-card">
            <Link
              to={usersLinkForRole(role)}
              className="flex min-h-16 items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-sunken focus-visible:outline-offset-[-2px] sm:px-5"
            >
              <IconTile icon={ROLE_VISUALS[role].icon} tone={ROLE_VISUALS[role].tone} />
              <span className="min-w-0 flex-1 text-[0.90625rem] font-semibold break-words text-fg">{t(`dashboard.accounts.${label}`)}</span>
              <span className="font-numeric text-[1.625rem] leading-none font-semibold tracking-tight text-fg tabular-nums">{formatCount(counts[count])}</span>
              <ChevronRight aria-hidden="true" className="mirror-rtl size-5 shrink-0 text-fg-muted" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

export interface AdminDashboardProps {
  me: Me
}

/**
 * The admin dashboard (§8.1 AdminDashboard) in direction C: today's date and when the figures were
 * read; the visit figures as KPI tiles (the people inside now on the dark tile, refreshed while the
 * page is open), each a link to the list behind its number; the latest audit events as activity
 * rows; the active accounts by role.
 */
export function AdminDashboard({ me }: AdminDashboardProps) {
  const { t } = useTranslation(['admin', 'common'])
  const now = useNow()
  const dashboard = useAdminDashboard()
  const timeZone = me.company.timezone
  const data = dashboard.data
  const today = companyToday(timeZone, now)
  // The same primary action as on My visits (teal, as every primary button). On phones it sits beside
  // the title: compact, without its icon, so the title keeps one line.
  const invite = (size: 'sm' | 'md') => (
    <ButtonLink to={paths.inviteVisitor} size={size} icon={size === 'md' ? <UserPlus aria-hidden="true" /> : undefined}>
      {t('common:nav.items.inviteVisitor')}
    </ButtonLink>
  )

  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        meta={
          <MetaLine
            items={[
              <Fragment key="date">
                <CalendarDays aria-hidden="true" className="size-4 shrink-0" />
                {formatDate(now, timeZone)}
              </Fragment>,
              data && (
                <span key="updated" className="tabular-nums">
                  {t('dashboard.updated', { time: formatTime(dashboard.dataUpdatedAt, timeZone) })}
                </span>
              ),
            ]}
          />
        }
        actions={invite('md')}
        mobileActions={invite('sm')}
      />
      {dashboard.isError ? (
        <LoadErrorAlert title={t('dashboard.loadError')} error={dashboard.error} onRetry={() => void dashboard.refetch()} />
      ) : !data ? (
        <PageSpinner label={t('dashboard.loading')} />
      ) : (
        <div className="flex flex-col gap-4 sm:gap-5 lg:gap-6">
          <section aria-labelledby="dashboard-visits">
            <h2 id="dashboard-visits" className="sr-only">
              {t('dashboard.visits.title')}
            </h2>
            <StatGrid>
              <StatTile
                label={t('dashboard.visits.today')}
                value={formatCount(data.counts.visits_today)}
                icon={CalendarDays}
                tone="info"
                to={historyLinkForDay(today)}
              />
              <StatTile
                label={t('dashboard.visits.insideNow')}
                value={formatCount(data.counts.inside_now)}
                variant="emphasis"
                aside={<LiveIndicator label={t('dashboard.live')} tone="highlight" />}
                icon={DoorOpen}
                to={paths.inside}
              />
              <StatTile label={t('dashboard.visits.all')} value={formatCount(data.counts.visits_total)} icon={FileClock} to={paths.history} />
              <StatTile label={t('dashboard.visits.visitors')} value={formatCount(data.counts.visitors_total)} icon={Contact} to={paths.visitors} />
            </StatGrid>
          </section>

          <div className="grid grid-cols-1 items-start gap-4 sm:gap-5 lg:grid-cols-3 lg:gap-6">
            <Card title={t('dashboard.audit.title')} titleId="dashboard-activity" className="lg:col-span-2" flush>
              <RecentAudit events={data.recent_audit} timeZone={timeZone} now={now} />
              <div className="flex justify-end border-t border-border-subtle px-4 sm:px-5">
                <Link
                  to={paths.adminAudit}
                  className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-accent-text hover:underline"
                >
                  {t('dashboard.audit.open')}
                  <ChevronRight aria-hidden="true" className="mirror-rtl size-4" />
                </Link>
              </div>
            </Card>
            {/* The side column; on tablets its two cards share a row under the activity. */}
            <div className="grid grid-cols-1 items-start gap-4 sm:gap-5 md:grid-cols-2 lg:grid-cols-1 lg:gap-6">
              <AccountsCard counts={data.counts} />
              <CompanyCard now={now} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}

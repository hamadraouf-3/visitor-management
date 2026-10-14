import { Building2, CalendarCheck, CalendarPlus, FileQuestion, Pencil, ShieldX } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isApiError } from '../../api/client'
import { hasAnyRole, SECTION_ACCESS } from '../../auth/roles'
import { ApiErrorMessage } from '../../components/ui/ApiErrorMessage'
import { Button, ButtonLink } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { EmailText } from '../../components/ui/EmailText'
import { EmptyState } from '../../components/ui/EmptyState'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { PageHeader } from '../../components/ui/PageHeader'
import { Pagination } from '../../components/ui/Pagination'
import { PhoneLink } from '../../components/ui/PhoneLink'
import { SectionHeader } from '../../components/ui/SectionHeader'
import { PageSpinner } from '../../components/ui/Spinner'
import { StatTile } from '../../components/ui/StatTile'
import { useBackLink, useBackLinkToHere, type BackLink } from '../../hooks/useBackLink'
import { useStableId } from '../../hooks/useStableId'
import { pageParamValue, readPageParam, useUrlParams } from '../../hooks/useUrlParams'
import { paths } from '../../paths'
import type { Me, Visitor } from '../../types/api'
import { formatDate } from '../../utils/datetime'
import { mailtoHref } from '../../utils/email'
import { FactList } from '../visits/FactList'
import { ListPanel } from '../../components/ui/ListPanel'
import { EditVisitorDialog } from './EditVisitorDialog'
import { useVisitor, useVisitorVisits, VISITOR_HISTORY_PAGE_SIZE } from './queries'
import { VisitorHistoryTable } from './VisitorHistoryTable'
import { VISITOR_STAT_LABELS } from './visitorFields'

function VisitorLoadError({ error, back, onRetry }: { error: unknown; back: BackLink; onRetry: () => void }) {
  const { t } = useTranslation('visitors')
  const status = isApiError(error) ? error.status : 0
  const backAction = (
    <ButtonLink to={back.to} state={back.state} variant="secondary">
      {back.label}
    </ButtonLink>
  )
  if (status === 404) {
    return (
      <>
        <PageHeader title={t('profile.notFound.title')} back={back} />
        <EmptyState icon={FileQuestion} title={t('profile.notFound.heading')} action={backAction} />
      </>
    )
  }
  if (status === 403) {
    return (
      <>
        <PageHeader title={t('profile.noAccess.title')} back={back} />
        <EmptyState icon={ShieldX} title={t('profile.noAccess.heading')} description={<ApiErrorMessage error={error} />} action={backAction} />
      </>
    )
  }
  return (
    <>
      <PageHeader title={t('profile.title')} back={back} />
      <LoadErrorAlert title={t('profile.loadError')} error={error} onRetry={onRetry} />
    </>
  )
}

function ContactCard({ visitor, timeZone }: { visitor: Visitor; timeZone: string }) {
  const { t } = useTranslation('visitors')
  return (
    <Card title={t('profile.contact.title')} className="lg:col-span-2">
      <FactList
        items={[
          {
            term: t('fields.email'),
            description: visitor.email ? (
              // 44 px tall on touch screens, like the phone link below it, the layout unchanged.
              <a
                href={mailtoHref(visitor.email)}
                className="inline-flex max-w-full items-center rounded-sm text-accent-text hover:underline pointer-coarse:-my-3 pointer-coarse:py-3"
              >
                <EmailText address={visitor.email} />
              </a>
            ) : (
              '—'
            ),
          },
          {
            term: t('fields.phone'),
            description: visitor.phone ? <PhoneLink phone={visitor.phone} label={t('profile.call', { name: visitor.full_name })} /> : '—',
          },
          { term: t('fields.company'), description: visitor.company_name ?? '—' },
          { term: t('profile.contact.added'), description: formatDate(visitor.created_at, timeZone) },
        ]}
      />
    </Card>
  )
}

export interface VisitorProfileProps {
  visitorId: string
  me: Me
}

/**
 * A visitor's profile (§10 /visitors/:id), direction C: the name with the company as its line of
 * facts, contact details beside the visit count (a KPI tile, the last check-in at its foot), and
 * the paginated history as a list card under its section title. Both are limited to the caller's
 * scope by the server. Inviting the visitor again is the main action for those who can invite;
 * editing is offered only when `permissions.can_edit`.
 */
export function VisitorProfile({ visitorId, me }: VisitorProfileProps) {
  const { t } = useTranslation('visitors')
  const timeZone = me.company.timezone
  const back = useBackLink({ to: paths.visitors, label: t('backToVisitors') })
  // Generic words: the label is kept in the browser's history with the visit page's entry. The
  // visit page names the visitor itself once it has loaded the visit (`visitBackLink`).
  const historyBack = useBackLinkToHere(t('profile.backToProfile'))
  const [params, updateParams] = useUrlParams()
  const page = readPageParam(params)
  const visitorQuery = useVisitor(visitorId)
  const history = useVisitorVisits(visitorId, page, visitorQuery.isSuccess)
  const [editing, setEditing] = useState(false)
  const historyHeadingId = useStableId('visit-history')
  const visitor = visitorQuery.data

  if (!visitor) {
    if (visitorQuery.isError) return <VisitorLoadError error={visitorQuery.error} back={back} onRetry={() => void visitorQuery.refetch()} />
    return (
      <>
        <PageHeader title={t('profile.title')} back={back} />
        <PageSpinner label={t('profile.loading')} />
      </>
    )
  }

  const canInvite = hasAnyRole(me.user.roles, SECTION_ACCESS.inviteVisitor)
  const historyData = history.data
  const lastCheckIn = visitor.stats.last_visit_at

  return (
    <>
      <PageHeader
        title={visitor.full_name}
        // Never the visitor's name: the browser keeps page titles in its saved history (§7.2 shared devices).
        documentTitle={t('profile.documentTitle')}
        meta={
          visitor.company_name && (
            <p className="flex items-center gap-1.5 text-sm text-fg-secondary">
              <Building2 aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
              <span className="min-w-0 break-words">{visitor.company_name}</span>
            </p>
          )
        }
        back={back}
        actions={
          (canInvite || visitor.permissions.can_edit) && (
            <>
              {canInvite && (
                <ButtonLink to={paths.inviteVisitorAgain(visitor.id)} icon={<CalendarPlus aria-hidden="true" />}>
                  {t('profile.inviteAgain')}
                </ButtonLink>
              )}
              {visitor.permissions.can_edit && (
                <Button variant="secondary" icon={<Pencil aria-hidden="true" />} onClick={() => setEditing(true)}>
                  {t('profile.edit')}
                </Button>
              )}
            </>
          )
        }
      />

      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-3">
          <ContactCard visitor={visitor} timeZone={timeZone} />
          <StatTile
            label={VISITOR_STAT_LABELS.total}
            value={visitor.stats.total_visits}
            icon={CalendarCheck}
            tone="accent"
            hint={
              <>
                <span className="block">{VISITOR_STAT_LABELS.lastCheckIn}</span>
                <span className="block font-medium text-fg">{lastCheckIn ? formatDate(lastCheckIn, timeZone) : '—'}</span>
              </>
            }
          />
        </div>

        <section aria-labelledby={historyHeadingId} className="flex flex-col gap-3">
          <SectionHeader id={historyHeadingId} title={t('profile.history.title')} count={historyData && historyData.total > 0 ? historyData.total : undefined} />
          {history.isError ? (
            <LoadErrorAlert title={t('profile.history.loadError')} error={history.error} onRetry={() => void history.refetch()} />
          ) : (
            <ListPanel
              frameFrom="lg"
              footer={
                historyData &&
                historyData.total > 0 && (
                  <Pagination
                    page={page}
                    pageSize={VISITOR_HISTORY_PAGE_SIZE}
                    total={historyData.total}
                    label={t('profile.history.pagesLabel')}
                    onPageChange={(next) => updateParams({ page: pageParamValue(next) })}
                  />
                )
              }
            >
              <VisitorHistoryTable
                visits={historyData?.items ?? []}
                timeZone={timeZone}
                backLink={historyBack}
                loading={history.isPending || history.isPlaceholderData}
                framed={false}
                empty={<EmptyState icon={CalendarCheck} title={t('profile.history.emptyTitle')} />}
              />
            </ListPanel>
          )}
        </section>
      </div>

      {editing && <EditVisitorDialog visitor={visitor} onClose={() => setEditing(false)} />}
    </>
  )
}

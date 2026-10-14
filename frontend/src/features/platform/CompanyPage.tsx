import { Ban, Building2, CalendarDays, Ellipsis, Pencil, Power, ScrollText, UsersRound } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { getErrorMessage, hasErrorCode } from '../../api/client'
import { Button, ButtonLink } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { DescriptionList } from '../../components/ui/DescriptionList'
import { Dialog } from '../../components/ui/Dialog'
import { EmptyState } from '../../components/ui/EmptyState'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { Menu, type MenuItem } from '../../components/ui/Menu'
import { MetaLine } from '../../components/ui/MetaLine'
import { PageHeader } from '../../components/ui/PageHeader'
import { PageSpinner } from '../../components/ui/Spinner'
import { StatTile } from '../../components/ui/StatTile'
import { useToast } from '../../components/ui/toastContext'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { LANGUAGE_NAMES } from '../../i18n'
import { useCompanyName } from '../../i18n/useLanguage'
import { paths } from '../../paths'
import type { PlatformCompany } from '../../types/api'
import { formatDate, formatTimeZoneName } from '../../utils/datetime'
import { formatCount } from '../../utils/number'
import { platformTimeZone } from './companyFilters'
import { CompanyAdmins } from './CompanyAdmins'
import { CompanyIdentityCard } from './CompanyIdentityCard'
import { CompanyLogoTile } from './CompanyLogoTile'
import { CompanyStatusBadge } from './CompanyStatusBadge'
import { EditCompanyDialog } from './EditCompanyDialog'
import { usePlatformCompany, useSetCompanyActive } from './queries'

/**
 * Deactivating (after one line: it ends the company's sessions) and reactivating a company: the
 * action, its confirmation dialog, and the state both the page's buttons and its phone menu use.
 */
function useCompanyActivation(company: PlatformCompany, displayName: string) {
  const { t } = useTranslation('platform')
  const toast = useToast()
  const setActive = useSetCompanyActive(company.id)
  const [confirming, setConfirming] = useState(false)

  const apply = (active: boolean) =>
    setActive.mutate(active, {
      onSuccess: () => {
        setConfirming(false)
        toast.show({ tone: 'success', title: active ? t('company.reactivate.done', { name: displayName }) : t('company.deactivate.done', { name: displayName }) })
      },
      onError: (error) => toast.show({ tone: 'danger', title: getErrorMessage(error) }),
    })

  const dialog = (
    <Dialog
      open={confirming}
      role="alertdialog"
      onClose={() => setConfirming(false)}
      dismissible={!setActive.isPending}
      title={t('company.deactivate.title', { name: displayName })}
      description={t('company.deactivate.description')}
      footer={
        <>
          <Button variant="secondary" onClick={() => setConfirming(false)} disabled={setActive.isPending} focusableWhenDisabled>
            {t('company.cancel')}
          </Button>
          <Button variant="danger" loading={setActive.isPending} onClick={() => apply(false)}>
            {t('company.deactivate.confirm')}
          </Button>
        </>
      }
    />
  )
  return { pending: setActive.isPending, reactivate: () => apply(true), confirm: () => setConfirming(true), dialog }
}

/** The company's identity as facts. */
function CompanyFacts({ company }: { company: PlatformCompany }) {
  const { t } = useTranslation('platform')
  const timeZone = platformTimeZone()
  return (
    <Card title={t('company.details')}>
      <DescriptionList
        items={[
          { term: t('company.facts.name'), description: <span dir="auto">{company.name}</span> },
          {
            term: t('company.facts.nameAr'),
            description: company.name_ar ? (
              <span dir="rtl" lang="ar">
                {company.name_ar}
              </span>
            ) : (
              <span className="text-fg-muted">{t('company.facts.none')}</span>
            ),
          },
          {
            term: t('company.facts.slug'),
            description: (
              <span dir="ltr" className="font-mono text-[0.8125rem]">
                {company.slug}
              </span>
            ),
          },
          { term: t('company.facts.language'), description: <span lang={company.default_language}>{LANGUAGE_NAMES[company.default_language].name}</span> },
          { term: t('company.facts.timezone'), description: formatTimeZoneName(company.timezone), wide: true },
          { term: t('company.facts.created'), description: formatDate(company.created_at, timeZone) },
          company.deactivated_at ? { term: t('company.facts.deactivated'), description: formatDate(company.deactivated_at, timeZone) } : null,
        ]}
      />
    </Card>
  )
}

function CompanyView({ company }: { company: PlatformCompany }) {
  const { t } = useTranslation('platform')
  const displayName = useCompanyName(company)
  const [editing, setEditing] = useState(false)
  const activation = useCompanyActivation(company, displayName)
  const timeZone = platformTimeZone()
  const auditPath = `${paths.platformAudit}?company=${encodeURIComponent(company.id)}`
  // Phones: the three actions in one menu beside the title (PageHeader's `mobileActions`).
  const menuItems: MenuItem[] = [
    { id: 'edit', label: t('company.edit'), icon: Pencil, onSelect: () => setEditing(true) },
    company.is_active
      ? { id: 'deactivate', label: t('company.deactivate.action'), icon: Ban, onSelect: activation.confirm, tone: 'danger' }
      : { id: 'reactivate', label: t('company.reactivate.action'), icon: Power, onSelect: activation.reactivate },
    { id: 'audit', label: t('company.auditLink'), icon: ScrollText, to: auditPath },
  ]

  return (
    <>
      <PageHeader
        title={displayName}
        // The company's logo beside its name (Phase 12); a company without one has the building tile.
        leading={<CompanyLogoTile company={company} size="lg" />}
        back={{ to: paths.platformCompanies, label: t('company.back') }}
        meta={
          <MetaLine
            stackOnPhones
            items={[
              <CompanyStatusBadge key="status" company={company} size="md" />,
              <span key="slug" dir="ltr" className="font-mono text-[0.8125rem]">
                {company.slug}
              </span>,
              company.deactivated_at
                ? t('company.deactivatedOn', { date: formatDate(company.deactivated_at, timeZone) })
                : t('company.createdOn', { date: formatDate(company.created_at, timeZone) }),
            ]}
          />
        }
        actions={
          <>
            <ButtonLink to={auditPath} variant="ghost" icon={<ScrollText aria-hidden="true" className="size-5" />}>
              {t('company.auditLink')}
            </ButtonLink>
            <Button variant="secondary" icon={<Pencil aria-hidden="true" />} onClick={() => setEditing(true)}>
              {t('company.edit')}
            </Button>
            {company.is_active ? (
              <Button variant="secondary" icon={<Ban aria-hidden="true" />} onClick={activation.confirm}>
                {t('company.deactivate.action')}
              </Button>
            ) : (
              <Button variant="primary" icon={<Power aria-hidden="true" />} loading={activation.pending} onClick={activation.reactivate}>
                {t('company.reactivate.action')}
              </Button>
            )}
          </>
        }
        mobileActions={
          <Menu
            items={menuItems}
            triggerLabel={t('company.actions')}
            trigger={<Ellipsis aria-hidden="true" className="size-5" />}
            triggerClassName="flex size-11 items-center justify-center rounded-control border border-border-strong bg-surface text-fg hover:bg-surface-muted"
          />
        }
      />
      {activation.dialog}
      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-2 gap-3 sm:gap-4">
          <StatTile label={t('company.facts.users')} value={formatCount(company.counts.active_users)} icon={UsersRound} tone="accent" />
          <StatTile label={t('company.facts.visits')} value={formatCount(company.counts.visits_last_30_days)} icon={CalendarDays} tone="info" />
        </div>
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="flex min-w-0 flex-col gap-6">
            <CompanyFacts company={company} />
            <CompanyIdentityCard company={company} displayName={displayName} />
          </div>
          <CompanyAdmins company={company} displayName={displayName} />
        </div>
      </div>
      {editing && <EditCompanyDialog company={company} displayName={displayName} onClose={() => setEditing(false)} />}
    </>
  )
}

/**
 * /platform/companies/:companyId: a company's details, state and counts, its identity (logo, colour,
 * sign-in link: Phase 12) with the ways to edit it and its e-mail texts, its administrators, and the
 * actions on it.
 */
export function CompanyPage() {
  const { t } = useTranslation('platform')
  const { companyId = '' } = useParams()
  const company = usePlatformCompany(companyId)
  const notFound = company.isError && hasErrorCode(company.error, 'NOT_FOUND')
  useDocumentTitle(notFound ? t('company.notFound') : undefined)

  if (company.isPending) return <PageSpinner />
  if (company.isError) {
    if (notFound) {
      return (
        <EmptyState
          headingLevel="h1"
          icon={Building2}
          title={t('company.notFound')}
          action={
            <ButtonLink to={paths.platformCompanies} variant="secondary">
              {t('company.back')}
            </ButtonLink>
          }
        />
      )
    }
    return <LoadErrorAlert title={t('company.loadError')} error={company.error} onRetry={() => void company.refetch()} />
  }
  return <CompanyView company={company.data} />
}

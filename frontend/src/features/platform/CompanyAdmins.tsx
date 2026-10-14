import { KeyRound, Mail, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getErrorMessage, rateLimitWaitSeconds } from '../../api/client'
import { Avatar } from '../../components/ui/Avatar'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { EmailText } from '../../components/ui/EmailText'
import { ListRow, RowList } from '../../components/ui/ListRow'
import { LoadErrorAlert } from '../../components/ui/LoadErrorAlert'
import { Spinner } from '../../components/ui/Spinner'
import { useToast } from '../../components/ui/toastContext'
import { useNow } from '../../hooks/useNow'
import type { PlatformCompany, PlatformCompanyAdmin } from '../../types/api'
import { cn } from '../../utils/cn'
import { formatRelativeDateTime } from '../../utils/datetime'
import { formatWaitDuration } from '../../utils/duration'
import { AddAdminDialog } from './AddAdminDialog'
import { platformTimeZone } from './companyFilters'
import { useCompanyAdmins, useSendAdminPasswordReset } from './queries'

/** One administrator: the name and what sets the account apart, the address, the last sign-in, and "Send reset link". */
function AdminRow({ admin, canReset, onReset, sending }: { admin: PlatformCompanyAdmin; canReset: boolean; onReset: () => void; sending: boolean }) {
  const { t } = useTranslation('platform')
  const now = useNow()
  return (
    <ListRow
      leading={<Avatar name={admin.full_name} className={cn(!admin.is_active && 'border border-dashed border-border-strong')} />}
      title={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn('break-words', admin.is_active ? 'text-fg' : 'text-fg-muted')}>{admin.full_name}</span>
          {!admin.is_active && <Badge tone="neutral">{t('company.admins.inactive')}</Badge>}
          {admin.is_active && admin.must_change_password && (
            <Badge tone="warning" icon={KeyRound}>
              {t('company.admins.temporaryPassword')}
            </Badge>
          )}
        </span>
      }
      detail={<EmailText address={admin.email} />}
      meta={
        admin.last_login_at
          ? t('company.admins.lastSignIn', { when: formatRelativeDateTime(admin.last_login_at, platformTimeZone(), now) })
          : t('company.admins.neverSignedIn')
      }
      action={
        canReset ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<Mail aria-hidden="true" />}
            loading={sending}
            onClick={onReset}
            aria-label={t('company.admins.sendResetNamed', { name: admin.full_name })}
          >
            {t('company.admins.sendReset')}
          </Button>
        ) : undefined
      }
    />
  )
}

/**
 * A company's administrators (SYSTEM_ADMIN users, B11-2: the only users the platform owner sees),
 * with "Add administrator" and, for an active administrator of an active company, a password reset
 * link (B11-11: the product's reset e-mail, 30 minutes, single use).
 */
export function CompanyAdmins({ company, displayName }: { company: PlatformCompany; displayName: string }) {
  const { t } = useTranslation('platform')
  const toast = useToast()
  const admins = useCompanyAdmins(company.id)
  const reset = useSendAdminPasswordReset(company.id)
  const [adding, setAdding] = useState(false)

  const sendReset = (admin: PlatformCompanyAdmin) =>
    reset.mutate(admin.id, {
      onSuccess: (sent) => toast.show({ tone: 'success', title: t('company.admins.resetSent'), description: t('company.admins.resetSentTo', { email: sent.sent_to }) }),
      onError: (error) => {
        // The account's budget of reset e-mails is used up: the server says for how long (`Retry-After`; UX review L9).
        const wait = rateLimitWaitSeconds(error)
        toast.show({
          tone: 'danger',
          title: t('company.admins.resetFailed'),
          description: wait !== null ? t('company.admins.resetLimited', { duration: formatWaitDuration(wait) }) : getErrorMessage(error),
        })
      },
    })

  return (
    <Card
      title={t('company.admins.title')}
      count={admins.data?.length}
      titleId="company-admins-title"
      flush
      actions={
        <Button variant="secondary" size="sm" icon={<UserPlus aria-hidden="true" />} onClick={() => setAdding(true)}>
          {t('company.admins.add')}
        </Button>
      }
    >
      {admins.isPending ? (
        <div className="flex justify-center p-6">
          <Spinner />
        </div>
      ) : admins.isError ? (
        <div className="p-4 sm:p-5">
          <LoadErrorAlert title={t('company.admins.loadError')} error={admins.error} onRetry={() => void admins.refetch()} />
        </div>
      ) : admins.data.length === 0 ? (
        <p className="p-5 text-sm text-fg-muted">{t('company.admins.empty')}</p>
      ) : (
        <RowList label={t('company.admins.listLabel', { name: displayName })}>
          {admins.data.map((admin) => (
            <AdminRow
              key={admin.id}
              admin={admin}
              canReset={company.is_active && admin.is_active}
              sending={reset.isPending && reset.variables === admin.id}
              onReset={() => sendReset(admin)}
            />
          ))}
        </RowList>
      )}
      {adding && <AddAdminDialog companyId={company.id} companyActive={company.is_active} onClose={() => setAdding(false)} />}
    </Card>
  )
}

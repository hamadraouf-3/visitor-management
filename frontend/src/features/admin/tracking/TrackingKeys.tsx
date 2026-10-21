import { KeyRound, Plus } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../../auth/useAuth'
import { Alert } from '../../../components/ui/Alert'
import { ApiErrorMessage } from '../../../components/ui/ApiErrorMessage'
import { Badge } from '../../../components/ui/Badge'
import { Button } from '../../../components/ui/Button'
import { Card } from '../../../components/ui/Card'
import { CopyButton } from '../../../components/ui/CopyButton'
import { Dialog } from '../../../components/ui/Dialog'
import { Field } from '../../../components/ui/Field'
import { Input } from '../../../components/ui/Input'
import { LoadErrorAlert } from '../../../components/ui/LoadErrorAlert'
import { Spinner } from '../../../components/ui/Spinner'
import { useToast } from '../../../components/ui/toastContext'
import { FOCUS_ROW_ATTRIBUTE, useListFocusRecovery } from '../../../hooks/useListFocusRecovery'
import { useStableId } from '../../../hooks/useStableId'
import type { TrackingKey, TrackingKeyCreated } from '../../../types/api'
import { formatDateTime } from '../../../utils/datetime'
import { useCreateTrackingKey, useRevokeTrackingKey, useTrackingKeys } from './queries'
import { validateKeyLabel } from './trackingForms'

/** A company holds at most two unrevoked keys (one in use, one for the rotation): the server's rule. */
export const MAX_ACTIVE_KEYS = 2

/**
 * The new key, shown once (as the temporary password of a new account is, D-11): its one line says so, the
 * key read-only and selected on open, a copy button. It lives in this dialog's state only, and the
 * mutation that brought it is dropped from the cache when the dialog closes (`gcTime: 0`).
 */
function KeyCreatedView({ created, onDone }: { created: TrackingKeyCreated; onDone: () => void }) {
  const { t } = useTranslation('admin')
  const keyRef = useRef<HTMLInputElement>(null)
  return (
    <Dialog
      open
      onClose={onDone}
      initialFocusRef={keyRef}
      title={t('tracking.keys.created.title', { label: created.label })}
      description={t('tracking.keys.created.description')}
      footer={<Button onClick={onDone}>{t('tracking.keys.created.done')}</Button>}
    >
      <div className="flex flex-col gap-2">
        <Field label={t('tracking.keys.created.key')}>
          <Input ref={keyRef} readOnly dir="ltr" value={created.secret} className="font-mono" onFocus={(event) => event.target.select()} />
        </Field>
        <CopyButton value={created.secret} label={t('tracking.keys.created.copy')} copiedLabel={t('tracking.keys.created.copied')} className="self-start" />
      </div>
    </Dialog>
  )
}

/** A key for the provider: its label, then the key shown once. */
function CreateKeyDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('admin')
  const create = useCreateTrackingKey()
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | undefined>()
  const [created, setCreated] = useState<TrackingKeyCreated | null>(null)
  const formId = useStableId('create-key')
  const fieldId = useStableId('key-label')

  if (created) return <KeyCreatedView created={created} onDone={onClose} />

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const problem = validateKeyLabel(label)
    setError(problem)
    if (problem) {
      document.getElementById(fieldId)?.focus()
      return
    }
    create.mutate({ label: label.trim() }, { onSuccess: setCreated })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('tracking.keys.create')}
      dismissible={!create.isPending}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending} focusableWhenDisabled>
            {t('tracking.cancel')}
          </Button>
          <Button type="submit" form={formId} loading={create.isPending}>
            {t('tracking.keys.createConfirm')}
          </Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
        {create.isError && (
          <Alert tone="danger">
            <ApiErrorMessage error={create.error} />
          </Alert>
        )}
        <Field id={fieldId} label={t('tracking.keys.label')} required error={error}>
          <Input autoComplete="off" value={label} onChange={(event) => setLabel(event.target.value)} />
        </Field>
      </form>
    </Dialog>
  )
}

/** Revoking a key, after one line: the provider's requests with it are refused from then on. */
function RevokeKeyDialog({ trackingKey, onClose, onRevoked }: { trackingKey: TrackingKey; onClose: () => void; onRevoked: () => void }) {
  const { t } = useTranslation('admin')
  const toast = useToast()
  const revoke = useRevokeTrackingKey()
  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onClose}
      dismissible={!revoke.isPending}
      title={t('tracking.keys.revokeTitle', { label: trackingKey.label })}
      description={t('tracking.keys.revokeDescription')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={revoke.isPending} focusableWhenDisabled>
            {t('tracking.keys.keep')}
          </Button>
          <Button
            variant="danger"
            loading={revoke.isPending}
            onClick={() =>
              revoke.mutate(trackingKey.id, {
                onSuccess: () => {
                  toast.show({ tone: 'success', title: t('tracking.keys.revoked', { label: trackingKey.label }) })
                  onRevoked()
                  onClose()
                },
              })
            }
          >
            {t('tracking.keys.revoke')}
          </Button>
        </>
      }
    >
      {revoke.isError ? (
        <Alert tone="danger">
          <ApiErrorMessage error={revoke.error} outsideForm />
        </Alert>
      ) : undefined}
    </Dialog>
  )
}

/**
 * The provider's keys (`Authorization: Bearer …` of the ingestion): each by its label and prefix, when it
 * was made and by whom, when it was last used, and its state; revoke for one in use. A new key's own text
 * is shown once. At most two in use: "Create key" then waits, with the reason beside it.
 */
export function TrackingKeysCard() {
  const { t } = useTranslation('admin')
  const { me } = useAuth()
  const timeZone = me?.company.timezone ?? 'UTC'
  const keys = useTrackingKeys()
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<TrackingKey | null>(null)
  const limitId = useStableId('key-limit')
  const listRef = useRef<HTMLUListElement>(null)
  const createRef = useRef<HTMLButtonElement>(null)
  // A revoked key keeps its row but loses its button: the focus goes on to the next key in use (F15-32).
  const recoverFocus = useListFocusRecovery({ list: listRef, fallback: createRef, version: keys.data })
  const inUse = (keys.data ?? []).filter((key) => key.revoked_at === null).length
  const atLimit = inUse >= MAX_ACTIVE_KEYS

  return (
    <Card
      title={t('tracking.keys.title')}
      actions={
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
          {atLimit && (
            <span id={limitId} className="text-sm font-semibold text-fg-muted">
              {t('tracking.keys.limit')}
            </span>
          )}
          <Button
            ref={createRef}
            variant="secondary"
            icon={<Plus aria-hidden="true" />}
            disabled={!keys.data || atLimit}
            focusableWhenDisabled
            aria-describedby={atLimit ? limitId : undefined}
            onClick={() => setCreating(true)}
          >
            {t('tracking.keys.create')}
          </Button>
        </div>
      }
    >
      {keys.isError ? (
        <LoadErrorAlert title={t('tracking.keys.loadError')} error={keys.error} onRetry={() => void keys.refetch()} />
      ) : !keys.data ? (
        <Spinner label={t('tracking.keys.loading')} />
      ) : keys.data.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('tracking.keys.empty')}</p>
      ) : (
        <ul ref={listRef} aria-label={t('tracking.keys.title')} className="-my-3 divide-y divide-border-subtle">
          {keys.data.map((key) => (
            <li key={key.id} {...(key.revoked_at === null ? { [FOCUS_ROW_ATTRIBUTE]: key.id } : {})} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <KeyRound aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-semibold break-words text-fg">{key.label}</span>
                    <span dir="ltr" className="font-mono text-[0.8125rem] text-fg-secondary">
                      {key.prefix}…
                    </span>
                    {key.revoked_at !== null ? <Badge tone="neutral">{t('tracking.keys.revokedBadge')}</Badge> : <Badge tone="success">{t('tracking.keys.inUse')}</Badge>}
                  </p>
                  <p className="mt-0.5 text-meta text-fg-muted tabular-nums">
                    {key.created_by
                      ? t('tracking.keys.createdByOn', { name: key.created_by.full_name, when: formatDateTime(key.created_at, timeZone) })
                      : t('tracking.keys.createdOn', { when: formatDateTime(key.created_at, timeZone) })}
                  </p>
                  <p className="text-meta text-fg-muted tabular-nums">
                    {key.revoked_at !== null
                      ? t('tracking.keys.revokedOn', { when: formatDateTime(key.revoked_at, timeZone) })
                      : key.last_used_at
                        ? t('tracking.keys.lastUsed', { when: formatDateTime(key.last_used_at, timeZone) })
                        : t('tracking.keys.neverUsed')}
                  </p>
                </div>
              </div>
              {key.revoked_at === null && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="self-start sm:self-center"
                  aria-label={t('tracking.keys.revokeNamed', { label: key.label })}
                  onClick={() => setRevoking(key)}
                >
                  {t('tracking.keys.revoke')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {creating && <CreateKeyDialog onClose={() => setCreating(false)} />}
      {revoking && <RevokeKeyDialog key={revoking.id} trackingKey={revoking} onClose={() => setRevoking(null)} onRevoked={() => recoverFocus(revoking.id)} />}
    </Card>
  )
}

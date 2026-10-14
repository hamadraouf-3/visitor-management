import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { ApiErrorMessage } from '../../components/ui/ApiErrorMessage'
import { PageHeader } from '../../components/ui/PageHeader'
import { PageSpinner } from '../../components/ui/Spinner'
import { useUrlParams } from '../../hooks/useUrlParams'
import { INVITE_VISITOR_PARAM, paths } from '../../paths'
import type { Me, VisitCreate, VisitCreateResult } from '../../types/api'
import { useVisitor } from '../visitors/queries'
import type { TypedVisitor } from './invitationText'
import { InviteSuccess } from './InviteSuccess'
import { InviteVisitorForm } from './InviteVisitorForm'

interface Created {
  result: VisitCreateResult
  typedVisitor: TypedVisitor | null
}

/** The new visitor as typed in the request (the success view compares it with the visitor the server used). */
function typedVisitorOf(body: VisitCreate): TypedVisitor | null {
  return body.visitor ? { fullName: body.visitor.full_name, email: body.visitor.email ?? null } : null
}

/**
 * The invite flow: the form, then the outcome, each with its own page title. The one-time pass
 * link lives only in this component's state; leaving the page or inviting another visitor
 * discards it. With `?visitor=<id>` the form starts with that returning visitor.
 */
export function InviteVisitor({ me }: { me: Me }) {
  const { t } = useTranslation('visits')
  const [params, updateParams] = useUrlParams()
  const [created, setCreated] = useState<Created | null>(null)
  // A new key gives the next invitation a fresh form with fresh defaults (e.g. the start time).
  const [formKey, setFormKey] = useState(0)
  // The visitor is resolved through the scoped GET /visitors/{id}, so the link reveals nothing
  // the caller could not open anyway.
  const visitorId = formKey === 0 ? params.get(INVITE_VISITOR_PARAM) : null
  const preselected = useVisitor(visitorId ?? '', visitorId !== null)

  if (created) {
    return (
      <InviteSuccess
        result={created.result}
        typedVisitor={created.typedVisitor}
        me={me}
        onInviteAnother={() => {
          setCreated(null)
          setFormKey((key) => key + 1)
          updateParams({ [INVITE_VISITOR_PARAM]: null })
        }}
      />
    )
  }
  return (
    <>
      <PageHeader title={t('invite.title')} back={{ to: paths.myVisits, label: t('backToMyVisits') }} />
      {visitorId !== null && preselected.isPending ? (
        <PageSpinner label={t('invite.loadingVisitor')} />
      ) : (
        <>
          {visitorId !== null && preselected.isError && (
            <Alert tone="warning" role="status" title={t('invite.visitorLoadError')} className="mb-6">
              <ApiErrorMessage error={preselected.error} />
            </Alert>
          )}
          <InviteVisitorForm
            key={formKey}
            me={me}
            focusOnMount={formKey > 0}
            initialVisitor={visitorId !== null ? (preselected.data ?? null) : null}
            onCreated={(result, body) => setCreated({ result, typedVisitor: typedVisitorOf(body) })}
          />
        </>
      )}
    </>
  )
}

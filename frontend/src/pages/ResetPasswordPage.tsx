import { KeyRound } from 'lucide-react'
import { Navigate, useLoaderData } from 'react-router'
import { ResetPasswordForm } from '../features/auth/ResetPasswordForm'
import type { ResetTokenLoaderData } from '../features/auth/resetToken'
import { useRememberedCompanyAddress } from '../identity/useRememberedCompanyAddress'
import { CenteredLayout } from '../layouts/CenteredLayout'

/**
 * `/reset-password#token=…`, neutral; a link the backend wrote names its company (`?c={slug}`,
 * Phase 12) and shows that company's identity. An older link without a company, opened on a device
 * that has signed in before, leads to the same page of the device's company, as `/login` does: the
 * token is the loader's by then (the route never loads twice), so the form keeps it. The document
 * title follows the form's state (the form sets it: an invalid link is not "Choose a new password").
 */
export function ResetPasswordPage() {
  // The route loader already read the token and stripped it from the URL (the company stays in the query).
  const { token } = useLoaderData() as ResetTokenLoaderData
  const companyAddress = useRememberedCompanyAddress()
  if (companyAddress) return <Navigate to={companyAddress} replace />
  return (
    <CenteredLayout neutralIcon={KeyRound}>
      <ResetPasswordForm token={token} />
    </CenteredLayout>
  )
}

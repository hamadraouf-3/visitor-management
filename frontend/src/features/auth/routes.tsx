import { ChangePasswordPage } from '../../pages/ChangePasswordPage'
import { ForgotPasswordPage } from '../../pages/ForgotPasswordPage'
import { LoginPage } from '../../pages/LoginPage'
import { ResetPasswordPage } from '../../pages/ResetPasswordPage'
import type { FeatureModule } from '../types'
import { captureResetToken } from './resetToken'

export const authFeature: FeatureModule = {
  publicRoutes: [
    { path: 'login', Component: LoginPage },
    // A company's own sign-in page (Phase 12): its identity above the same form. An unknown slug is the neutral page.
    { path: 'c/:slug', Component: LoginPage },
    { path: 'c/:slug/login', Component: LoginPage },
    { path: 'forgot-password', Component: ForgotPasswordPage },
    {
      path: 'reset-password',
      // The loader strips `#token=` from the address bar before the page renders.
      loader: () => captureResetToken(),
      shouldRevalidate: () => false,
      Component: ResetPasswordPage,
    },
  ],
  routes: [{ path: 'change-password', Component: ChangePasswordPage }],
}

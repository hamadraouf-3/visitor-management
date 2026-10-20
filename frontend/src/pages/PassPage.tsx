import { Printer, TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router'
import { AppearanceToggle } from '../appearance/AppearanceToggle'
import { IdentityLockup } from '../components/app/IdentityLockup'
import { LanguageSwitcher } from '../components/app/LanguageSwitcher'
import { QrCode } from '../components/qr/QrCode'
import { Button } from '../components/ui/Button'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { withCompany } from '../identity/links'
import { useIdentity } from '../identity/useIdentity'
import { paths } from '../paths'
import { passTokenFromHash } from '../scanner/parsePassToken'

/**
 * Public visitor pass (`/pass?c={slug}#<token>`, D-20; an older link `/pass#<token>` still works).
 * The token stays in the URL fragment and is never sent to a server: no token oracle, no PII.
 * Lazily loaded so `qrcode` is not part of the main bundle.
 *
 * The pass carries the identity of the company the link names (Phase 12): its logo or wordmark
 * over the card, its colour on the card's head, its name in the title. For that the page asks the
 * public brand endpoint for the slug, and nothing else: no session check, no manifest, and never
 * the token. A link without a company, or with a slug nobody has, is the neutral pass (no logo,
 * the default colours).
 *
 * Direction C's pass card: the card's coloured head naming the pass, the QR code large on white
 * (black on white, as scanners need it), a perforation and printing. No notes (decision 3, the user's request 8): what to do at reception and what to
 * bring are in the invitation e-mail that links here. In the visitor's language: the
 * device's (or the browser's) like the sign-in page, and the language switch at the top
 * inline-end corner (it works signed out, remembering the choice on the device), with the
 * appearance toggle beside it (Phase 13). On paper the
 * card is black on white under the company's logo, so a printed pass still carries its identity.
 */
export default function PassPage() {
  const { t } = useTranslation('pass')
  useDocumentTitle(t('title'))
  const { hash } = useLocation()
  const { linkSlug } = useIdentity()
  const token = passTokenFromHash(hash)

  return (
    <div className="flex min-h-dvh flex-col items-center bg-canvas px-4 pt-4 pb-10 sm:px-6 print:bg-white print:p-0">
      {/* As the sign-in page's header: where the two switches do not fit one row, the language switch takes the next. */}
      <header className="flex w-full flex-wrap justify-end gap-2 print:hidden">
        <AppearanceToggle />
        <LanguageSwitcher />
      </header>
      <main id="main-content" className="flex w-full max-w-[26rem] flex-col items-center gap-6 pt-4">
        <IdentityLockup surface="page" size="lg" className="print:hidden" />
        <div className="hidden justify-center print:flex">
          <IdentityLockup surface="paper" size="lg" />
        </div>

        {token ? (
          <article
            aria-labelledby="pass-title"
            className="w-full overflow-hidden rounded-[1.375rem] border border-border bg-surface shadow-pop print:rounded-none print:border-2 print:border-black print:shadow-none"
          >
            {/* The head: the company's colour (the product's teal without one; white text at least 4.5:1), black on white on paper. */}
            <div className="theme-shell bg-shell px-6 pt-6 pb-24 text-center text-fg print:bg-white print:pb-4 print:text-black">
              <h1 id="pass-title" className="text-2xl font-bold">
                {t('title')}
              </h1>
            </div>
            {/* The code overlaps the head on a white tile, large and with its quiet zone. */}
            <div className="-mt-20 px-6 print:mt-0 print:pb-6">
              <div className="mx-auto w-full max-w-[18.5rem] rounded-[1.125rem] bg-white p-3 shadow-pop ring-1 ring-border print:max-w-64 print:p-0 print:shadow-none print:ring-0">
                {/* The code is the link itself, with its company: what the reception scans and what the e-mail carries are one address. */}
                <QrCode value={`${window.location.origin}${withCompany(paths.pass, linkSlug)}#${token}`} label={t('qrLabel')} />
              </div>
            </div>
            <div className="flex flex-col gap-5 px-6 pt-6 pb-6 print:hidden">
              {/* A perforation between the pass and its stub, with the ticket's notches at its ends. */}
              <div
                aria-hidden="true"
                className="relative -mx-6 border-t-2 border-dashed border-border before:absolute before:-start-3 before:-top-3 before:size-6 before:rounded-full before:border before:border-border before:bg-canvas after:absolute after:-end-3 after:-top-3 after:size-6 after:rounded-full after:border after:border-border after:bg-canvas"
              />
              <Button variant="secondary" fullWidth icon={<Printer aria-hidden="true" />} onClick={() => window.print()}>
                {t('print')}
              </Button>
            </div>
          </article>
        ) : (
          <section
            role="alert"
            className="flex w-full flex-col items-center gap-3 rounded-card border border-warning-border bg-warning-surface p-6 text-center text-warning-text"
          >
            <TriangleAlert aria-hidden="true" className="size-8 text-warning-solid" />
            <h1 className="text-lg font-bold">{t('invalidTitle')}</h1>
            <p className="text-sm">{t('invalidDescription')}</p>
          </section>
        )}
      </main>
    </div>
  )
}

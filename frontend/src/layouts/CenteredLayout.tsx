import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { AppearanceToggle } from '../appearance/AppearanceToggle'
import { IdentityLockup, NeutralMark } from '../components/app/IdentityLockup'
import { LanguageSwitcher } from '../components/app/LanguageSwitcher'
import { useIdentity } from '../identity/useIdentity'

interface CenteredLayoutProps {
  children: ReactNode
  /** Small text under the lockup (the platform owner's "Platform" label). */
  eyebrow?: ReactNode
  /** The language switch in the header; the company session's by default (the platform owner's area passes its own). */
  languageSwitch?: ReactNode
  /**
   * The symbol a neutral page shows where a company's logo would stand (the sign-in and password
   * pages). Without it a neutral page has nothing above its content (an error page).
   */
  neutralIcon?: LucideIcon
}

/**
 * Public pages (sign-in, password reset, errors): the page's identity above a card-width column on
 * the canvas, and the language switch pinned to the window's top inline-end corner (top right in
 * English, top left in Arabic), within the page gutter at every width, with the appearance toggle
 * (Phase 13) beside it, on its inline-start side. Where the two would not fit one row (a larger text
 * size on a narrow screen) the language switch moves to a row of its own: never under the toggle.
 *
 * The identity (Phase 12) is the company's logo or wordmark on its own pages, the product's lockup
 * in the platform owner's area, and on a neutral page no logo and no name: only `neutralIcon`'s
 * mark. No small print under the card (the brand pass's decision 3: no explanatory notes).
 */
export function CenteredLayout({ children, eyebrow, languageSwitch, neutralIcon }: CenteredLayoutProps) {
  const { identity, pending } = useIdentity()
  // The room is kept while a company's identity is on its way, so the card does not move when it arrives.
  const hasHead = identity.kind !== 'neutral' || pending || neutralIcon !== undefined || Boolean(eyebrow)
  return (
    <div className="flex min-h-dvh flex-col items-center bg-canvas px-4 pt-4 pb-10 sm:px-6 sm:pt-5 sm:pb-16">
      <header data-public-header="" className="flex w-full flex-wrap justify-end gap-2">
        <AppearanceToggle />
        {languageSwitch ?? <LanguageSwitcher />}
      </header>
      <div className="flex w-full flex-1 flex-col items-center pt-6 sm:justify-center sm:pt-0">
        <main id="main-content" className="w-full max-w-md">
          {hasHead && (
            <div data-page-identity="" className="mb-8 flex flex-col items-center gap-3 text-center">
              {/* As tall as a logo in its room (3.5rem of picture, 1.5rem of padding, its edge): the card below does not move when the logo arrives. */}
              <div className="flex min-h-[5.125rem] items-center justify-center">
                <IdentityLockup surface="page" size="lg" neutral={neutralIcon ? <NeutralMark icon={neutralIcon} /> : null} />
              </div>
              {eyebrow && <div className="text-sm text-fg-muted">{eyebrow}</div>}
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  )
}

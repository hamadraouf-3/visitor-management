import { Menu as MenuIcon } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation } from 'react-router'
import { AppearanceToggle } from '../appearance/AppearanceToggle'
import { Drawer } from '../components/ui/Drawer'
import type { NavEntry } from '../features/types'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { cn } from '../utils/cn'
import { Navigation } from './Navigation'

/** Tailwind's `lg` breakpoint: from here on the sidebar is shown. */
const DESKTOP_QUERY = '(min-width: 64rem)'

export interface ShellFrameProps {
  /** The navigation entries this person may open (already filtered); none while a password change is required. */
  entries: readonly NavEntry[]
  /**
   * `theme-shell`: the coloured shell (a company's own colour, dark or light, else mawdoo3's side-nav teal). `theme-shell-deep`: the deep shell around a dark screen.
   * `theme-shell-platform`: the platform owner's shell (the deep teal; the slate in the dark colour
   * scheme, where a company's shell is the deep teal).
   */
  shellTheme: 'theme-shell' | 'theme-shell-deep' | 'theme-shell-platform'
  /** The page is dark from edge to edge (`data-surface="dark"`, F10-29): the appearance toggle says dark there. */
  darkSurface?: boolean
  /** The lockup at the head of the sidebar and the drawer (`md`) and in the top bar (`sm`). */
  renderLockup: (size: 'sm' | 'md') => ReactNode
  /** The language switch (sidebar head on desktops, top bar below), with the appearance toggle (Phase 13) on its inline-start side. */
  languageSwitch: ReactNode
  /** The account menu: direction C's user block at the sidebar's foot, a compact trigger in the top bar. */
  renderUserMenu: (placement: 'bar' | 'sidebar') => ReactNode
  children?: ReactNode
}

/**
 * The signed-in shell, direction C in mawdoo3's colours (F10-27, F10-29) or a company's own (Phase
 * 12), shared by the company app (`AppLayout`) and the platform owner's area (Phase 11):
 *
 * - Desktop (lg+): a fixed sidebar on the inline-start side (left in English, right in Arabic): the
 *   appearance toggle and the language switch in its top inline-start corner, which is the screen's
 *   (the owner's choice, 2026-10-20), with the lockup under them, the grouped navigation, and the user
 *   block at its foot; no top bar (it would hold nothing else).
 * - Tablet/mobile: a sticky top bar with a menu button that opens the navigation in a modal drawer
 *   of the same colour, the lockup, the appearance toggle, the language switch and the account menu.
 *
 * Everything on the shell takes its colours from the shell's tokens, so it follows the shell's ink:
 * white on a dark shell, the dark ink on a company's light one.
 */
export function ShellFrame({ entries, shellTheme, darkSurface = false, renderLockup, languageSwitch, renderUserMenu, children }: ShellFrameProps) {
  const { t } = useTranslation()
  const location = useLocation()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const mainRef = useRef<HTMLElement>(null)
  const previousPath = useRef(location.pathname)

  // After client-side navigation move focus to the new page's heading, so screen reader and
  // keyboard users start at the new content instead of the link they activated.
  useEffect(() => {
    if (previousPath.current === location.pathname) return
    previousPath.current = location.pathname
    const heading = mainRef.current?.querySelector<HTMLElement>('h1')
    ;(heading ?? mainRef.current)?.focus({ preventScroll: true })
  }, [location.pathname])

  return (
    // White on paper: with background graphics printed, the canvas would frame every white card.
    <div data-surface={darkSurface ? 'dark' : undefined} className="min-h-dvh bg-canvas print:bg-white">
      {/* Shown on focus as a pill over the shell. Its padding is set with `focus:` after
          `focus:not-sr-only` (which resets padding to 0), and its ring is drawn inside the pill, in the
          page's focus colour on the pill's surface (4.70:1), since the teal shell around it would hide a
          teal ring (1:1). */}
      <a
        href="#main-content"
        data-skip-link=""
        className="sr-only z-[70] rounded-control bg-surface font-semibold text-accent-text shadow-pop focus:not-sr-only focus:fixed focus:start-2 focus:top-2 focus:px-4 focus:py-2 focus-visible:outline-offset-[-5px]"
      >
        {t('app.skipToContent')}
      </a>

      {/* The shell ends at a line (`shell-edge`) only where its colour would blend into the canvas: a near-white company's. */}
      <aside className={cn(shellTheme, 'fixed inset-y-0 start-0 z-30 hidden w-64 flex-col border-e border-shell-edge bg-shell text-fg lg:flex print:hidden')}>
        {/* The two switches in its top inline-start corner, the screen's corner, not mid-screen at the sidebar's edge; the identity under them, with the sidebar's whole width. */}
        <div className="flex flex-col gap-2 ps-5 pe-4 pt-4 pb-2">
          {desktop && (
            <div data-shell-switches="" className="flex justify-start gap-2">
              <AppearanceToggle darkSurface={darkSurface} />
              {languageSwitch}
            </div>
          )}
          <div className="flex min-h-12 items-center">{renderLockup('md')}</div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{entries.length > 0 && <Navigation entries={entries} />}</div>
        {desktop && <div className="p-3">{renderUserMenu('sidebar')}</div>}
      </aside>

      {/* The sidebar's room (lg+) is only kept on screen: on paper the sidebar is hidden and the
          page uses the sheet's whole width, in either writing direction. */}
      <div className="flex min-h-dvh min-w-0 flex-col lg:ps-64 print:ps-0">
        {!desktop && (
          <header
            data-app-bar=""
            // Below 384 px a little less room around and between its controls: the lockup keeps what is left, and shrinks to it.
            className={cn(shellTheme, 'sticky top-0 z-20 flex h-16 items-center gap-2 border-b border-shell-edge bg-shell px-3 text-fg max-[24rem]:gap-1.5 max-[24rem]:px-2 sm:px-5 print:hidden')}
          >
            {entries.length > 0 && (
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                aria-expanded={drawerOpen}
                className="flex size-11 shrink-0 items-center justify-center rounded-control text-fg transition-colors hover:bg-surface-muted"
              >
                <MenuIcon aria-hidden="true" className="size-6" />
                <span className="sr-only">{t('nav.open')}</span>
              </button>
            )}
            {renderLockup('sm')}
            <div data-shell-switches="" className="ms-auto flex shrink-0 items-center gap-2 max-[24rem]:gap-1.5">
              <AppearanceToggle darkSurface={darkSurface} />
              {languageSwitch}
              {renderUserMenu('bar')}
            </div>
          </header>
        )}

        <main id="main-content" ref={mainRef} tabIndex={-1} className="flex-1 px-4 py-6 focus:outline-none sm:px-6 lg:px-8 lg:py-8">
          <div className="mx-auto w-full max-w-7xl">{children ?? <Outlet />}</div>
        </main>
      </div>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        // The drawer is named by the identity that heads it: the company's, or the product's in the platform owner's area.
        title={renderLockup('md')}
        panelClassName={shellTheme}
        // The drawer and the bar it opens from are the same teal, like the desktop sidebar.
        surfaceClassName="bg-shell"
      >
        <Navigation entries={entries} onNavigate={() => setDrawerOpen(false)} />
      </Drawer>
    </div>
  )
}

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useColorScheme } from '../../appearance/useAppearance'
import { CompanyLogo } from '../../components/app/CompanyLogo'
import { Card } from '../../components/ui/Card'
import { Spinner } from '../../components/ui/Spinner'
import { ACCENT_FILL_EDGE } from '../../components/ui/buttonStyles'
import { isLightSurface } from '../../identity/brand'
import { brandTokens } from '../../identity/tokens'
import { useTokenScope } from '../../identity/useTokenScope'
import type { BrandPalette, CompanyBrand } from '../../types/api'
import { cn } from '../../utils/cn'

export interface IdentityPreviewProps {
  /** The company's name in the UI language. */
  name: string
  /** The identity as edited: the saved brand with the unsaved pictures over it. */
  brand: CompanyBrand
  /** The palette of the colour in the field (POST /platform/brand/palette); null: the default colours. */
  palette: BrandPalette | null
  /** The palette of a newer colour is on its way; the one shown is the previous one. */
  updating?: boolean
  className?: string
}

/**
 * The colours of a company's e-mail as the server writes them (backend `app/email/identity.py`): the
 * bar and the primary button are the company's `surface` under its ink (a yellow company's button is
 * yellow with dark text), the button's edge, the name and the pill's text `strong`, the pill on
 * `tint`. A company without a colour has the default ones.
 */
const DEFAULT_EMAIL = { surface: '#188086', onSurface: '#ffffff', strong: '#188086', link: '#146e73', tint: '#e5f6f7' } as const

/** A line of text that is not there: the mock shows the identity, not a visit. */
function Line({ className }: { className?: string }) {
  return <span className={cn('block h-2 rounded-full', className)} />
}

/**
 * The identity as the company's people will see it (Phase 12), from the palette the server derives
 * for the colour in the field: a small shell with the logo and the current page's pill, a primary
 * button, a chip and a link on the content area, and the head of an e-mail as the server lays it
 * out (the bar in the company's colour, its logo or its name on white, the kind of message, the
 * primary button). The app is drawn with the app's own classes on the palette's tokens
 * (`useTokenScope`), in the colour scheme of this device, so what it shows is what the mapping
 * gives: a light colour's shell under dark ink with the logo on its plate, the deep shell with the
 * logo for dark surfaces in the dark scheme. A picture for the eye: one image for assistive
 * technology, named by the company.
 */
export function IdentityPreview({ name, brand, palette, updating = false, className }: IdentityPreviewProps) {
  const { t } = useTranslation('platform')
  // The scheme of this device's appearance (Phase 13), as the page around the preview.
  const darkScheme = useColorScheme() === 'dark'
  const tokens = useMemo(() => (palette ? brandTokens(palette) : null), [palette])
  // The dark scheme draws the content on the dark set and the shell as the deep one.
  const content = useTokenScope<HTMLDivElement>(tokens ? { ...tokens.light, ...(darkScheme ? tokens.dark : {}) } : null)
  const shell = useTokenScope<HTMLDivElement>(tokens ? (darkScheme ? tokens.deep : tokens.shell) : null)
  const email = palette ? { surface: palette.surface, onSurface: palette.on_surface, strong: palette.strong, link: palette.strong, tint: palette.tint } : DEFAULT_EMAIL

  return (
    <Card
      title={t('identity.preview.title')}
      actions={updating ? <Spinner size="sm" label={t('identity.preview.updating')} /> : undefined}
      className={className}
    >
      <div role="img" aria-label={t('identity.preview.label', { name })} data-identity-preview="" className="flex flex-col gap-3">
        <p aria-hidden="true" className="text-xs font-semibold text-fg-muted">
          {t('identity.preview.app')}
        </p>
        <div ref={content} aria-hidden="true" data-preview="app" className="overflow-hidden rounded-[0.875rem] border border-border">
          <div className="flex min-h-52">
            <div ref={shell} data-preview-shell="" className="theme-shell flex w-[42%] shrink-0 flex-col gap-3 border-e border-shell-edge bg-shell p-3 text-fg">
              <div className="flex min-h-9 items-center">
                <CompanyLogo brand={brand} name={name} surface="shell" size="sm" shellTone={palette && isLightSurface(palette) ? 'light' : 'dark'} decorative />
              </div>
              <div className="flex flex-col gap-1 text-[0.6875rem] leading-4 font-medium">
                <span data-preview-current="" className="rounded-[0.5rem] bg-accent px-2 py-1.5 font-semibold text-on-accent">
                  {t('identity.preview.navCurrent')}
                </span>
                <span className="px-2 py-1.5">{t('identity.preview.navOther')}</span>
                <span className="px-2 py-1.5">{t('identity.preview.navLast')}</span>
              </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col items-start gap-2.5 bg-canvas p-3">
              <span data-preview-button="" className={cn('inline-flex min-h-8 items-center rounded-[0.625rem] bg-accent px-3 text-xs font-semibold text-on-accent', ACCENT_FILL_EDGE)}>
                {t('identity.preview.button')}
              </span>
              <span
                data-preview-chip=""
                className="inline-flex items-center rounded-full border border-accent-border bg-accent-surface px-2 py-0.5 text-[0.6875rem] leading-5 font-semibold text-accent-text"
              >
                {t('identity.preview.chip')}
              </span>
              <div className="flex w-full flex-col gap-2 rounded-[0.625rem] border border-border bg-surface p-2.5">
                <Line className="w-3/4 bg-fg/20" />
                <Line className="w-1/2 bg-fg/10" />
                <span data-preview-link="" className="text-[0.6875rem] leading-4 font-semibold text-accent-text underline">
                  {t('identity.preview.link')}
                </span>
              </div>
            </div>
          </div>
        </div>

        <p aria-hidden="true" className="mt-1 text-xs font-semibold text-fg-muted">
          {t('identity.preview.email')}
        </p>
        {/* The e-mail's light design whatever this device's scheme: white, ink text, the company's colour (its dark one is
            in the e-mail texts' preview, Light / Dark, drawn by the server: Phase 13). */}
        <div aria-hidden="true" data-preview="email" className="overflow-hidden rounded-[0.875rem] border border-border bg-white text-ink-900">
          <span data-preview-rule="" className="block h-1.5 w-full" style={{ backgroundColor: email.surface }} />
          <div className="flex min-h-14 items-center justify-between gap-3 border-b border-ink-900/10 px-4 py-2.5">
            {brand.logo_url ? (
              <CompanyLogo brand={brand} name={name} surface="paper" size="sm" decorative />
            ) : (
              <span data-preview-wordmark="" dir="auto" className="min-w-0 text-base leading-tight font-bold break-words" style={{ color: email.link }}>
                {name}
              </span>
            )}
            <span
              data-preview-pill=""
              className="shrink-0 rounded-full px-2.5 py-1 text-[0.6875rem] leading-4 font-bold whitespace-nowrap"
              style={{ backgroundColor: email.tint, color: email.link }}
            >
              {t('identity.preview.emailKind')}
            </span>
          </div>
          <div className="flex flex-col items-start gap-3 p-4">
            <p className="text-sm leading-snug font-bold">{t('identity.preview.emailHeading', { name })}</p>
            <span className="flex w-full flex-col gap-1.5">
              <Line className="w-full bg-ink-900/15" />
              <Line className="w-2/3 bg-ink-900/15" />
            </span>
            <span
              data-preview-email-button=""
              className="inline-flex min-h-8 items-center rounded-[0.5rem] border-[1.5px] px-3 text-xs font-bold"
              style={{ backgroundColor: email.surface, color: email.onSurface, borderColor: email.strong }}
            >
              {t('identity.preview.emailButton')}
            </span>
          </div>
        </div>
      </div>
    </Card>
  )
}

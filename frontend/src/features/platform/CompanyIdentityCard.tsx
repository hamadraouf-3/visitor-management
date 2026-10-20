import { Mail, Palette } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { ButtonLink } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { CopyButton } from '../../components/ui/CopyButton'
import { DescriptionList } from '../../components/ui/DescriptionList'
import { parseCompanyBrand } from '../../identity/brand'
import { paths } from '../../paths'
import type { PlatformCompany } from '../../types/api'
import { signInLink } from './identityForm'

/**
 * A company's identity on its page (Phase 12): its logo, its colour and its sign-in link as facts,
 * with the ways to its identity and its e-mail texts, which together are what the company's people
 * and visitors see of it.
 */
export function CompanyIdentityCard({ company, displayName }: { company: PlatformCompany; displayName: string }) {
  const { t } = useTranslation('platform')
  const brand = parseCompanyBrand(company.brand, company.slug)
  const link = signInLink(company.slug)
  return (
    <Card
      title={t('company.identity.title')}
      actions={
        <div className="flex flex-wrap gap-2">
          <ButtonLink to={paths.platformCompanyEmailTemplates(company.id)} variant="secondary" size="sm" icon={<Mail aria-hidden="true" />}>
            {t('company.emailTexts.title')}
          </ButtonLink>
          <ButtonLink to={paths.platformCompanyIdentity(company.id)} variant="secondary" size="sm" icon={<Palette aria-hidden="true" />}>
            {t('company.identity.edit')}
          </ButtonLink>
        </div>
      }
    >
      <DescriptionList
        items={[
          {
            term: t('company.identity.logo'),
            description: brand.logo_url ? (
              // The logo for light surfaces on the card itself; on a white plate in the dark scheme only (Phase 13, F13-26).
              <span
                data-logo-plate="dark-scheme"
                className="inline-flex h-12 max-w-44 items-center rounded-item border border-transparent px-2.5 py-1.5 scheme-dark:border-border scheme-dark:bg-white"
              >
                <img
                  src={brand.logo_url}
                  alt={t('identity.logos.previewAlt', { slot: t('company.identity.logo'), name: displayName })}
                  decoding="async"
                  draggable={false}
                  className="block max-h-full max-w-full object-contain"
                />
              </span>
            ) : (
              <span className="text-fg-muted">{t('company.identity.noLogo')}</span>
            ),
          },
          {
            term: t('company.identity.colour'),
            description: brand.color ? (
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" data-colour-swatch="" className="size-6 rounded-[0.375rem] border border-border" style={{ backgroundColor: brand.color }} />
                <span dir="ltr" className="font-mono text-[0.8125rem]">
                  {brand.color}
                </span>
              </span>
            ) : (
              <span className="text-fg-muted">{t('company.identity.defaultColour')}</span>
            ),
          },
          {
            term: t('identity.link.title'),
            wide: true,
            description: (
              <span className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                <span dir="ltr" data-sign-in-link="" className="text-align-parent min-w-0 font-mono text-[0.8125rem] break-all">
                  {link}
                </span>
                <CopyButton value={link} size="sm" label={t('identity.link.copy')} copiedLabel={t('identity.link.copied')} className="shrink-0" />
              </span>
            ),
          },
        ]}
      />
    </Card>
  )
}

import { Save, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getErrorMessage } from '../../api/client'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { CopyButton } from '../../components/ui/CopyButton'
import { Dialog } from '../../components/ui/Dialog'
import { PageHeader } from '../../components/ui/PageHeader'
import { ReadOnlyField } from '../../components/ui/ReadOnlyField'
import { StickyActionBar } from '../../components/ui/StickyActionBar'
import { useToast } from '../../components/ui/toastContext'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { useStableId } from '../../hooks/useStableId'
import { BRAND_ASSET_KINDS, parseCompanyBrand, type BrandAssetKind } from '../../identity/brand'
import { coloursOfLogo, iconFromLogo, letterIcon, prepareIcon, prepareLogo, WORDMARK_MIN_RATIO, type LetterTile, type PreparedAsset } from '../../identity/imagePipeline'
import { DEFAULT_THEME_COLORS } from '../../identity/tokens'
import { useCompanyName } from '../../i18n/useLanguage'
import { paths } from '../../paths'
import type { CompanyBrand, PlatformCompany } from '../../types/api'
import { DATA_SEPARATOR } from '../../utils/text'
import { UnsavedChangesGuard } from '../admin/UnsavedChangesGuard'
import { CompanyLogoTile } from './CompanyLogoTile'
import { IdentityAssetSlot } from './IdentityAssetSlot'
import { IdentityColourField } from './IdentityColourField'
import {
  assetUrl,
  colourDraft,
  darkSurfaceOf,
  iconLetter,
  identityChanges,
  letterTileOf,
  originOf,
  preparationProblem,
  previewBrand,
  sameTile,
  signInLink,
  uploadProblem,
  type AssetDraft,
  type AssetDrafts,
  type IconOrigin,
} from './identityForm'
import { IdentityPreview } from './IdentityPreview'
import { IdentitySaveError, useBrandPalette, useRemoveBrandAssets, useResetBrandColour, useSaveCompanyIdentity, type IdentityStep } from './queries'

/** How long the colour must stay unchanged before its palette is asked for. */
export const PALETTE_DEBOUNCE_MS = 300

type Confirmation = { type: 'remove'; kind: BrandAssetKind; kinds: readonly BrandAssetKind[] } | { type: 'reset' }

/**
 * A company's identity, edited by the platform owner (Phase 12): its logo, the optional logo for
 * dark surfaces and the square icon (made by the page, replaceable by hand), its colour (suggested
 * from the logo's own pixels, typed, or picked), a live preview of the palette the server derives,
 * and the company's sign-in link.
 *
 * Pictures and the colour are staged on the page and saved together with "Save identity" (a file per
 * request, then the colour; a step that fails leaves what is still unsaved on the page). Taking
 * something away that is saved is its own action with one line of confirmation: "Remove" for a
 * file, "Reset to default colour" for the colour. A picture that is only staged is dropped without
 * asking: nothing is lost.
 *
 * The icon follows the logo. A logo that fits a square (an emblem, a short lockup) is put on a white
 * tile; a wordmark, which would be a speck in a browser tab, gives a tile in the company's colour
 * with the first letter of its name, and that tile is drawn again when the colour changes. An icon
 * chosen by hand is left alone by both. Removing the logo removes the icon with it (the one line
 * says so), unless the icon was chosen by hand during this visit of the page.
 */
export function IdentityEditor({ company }: { company: PlatformCompany }) {
  const { t } = useTranslation('platform')
  const toast = useToast()
  const displayName = useCompanyName(company)
  const brand: CompanyBrand = parseCompanyBrand(company.brand, company.slug)
  const colourInputId = useStableId('identity-colour')

  const [assets, setAssets] = useState<AssetDrafts>({})
  const [colourText, setColourText] = useState(brand.color ?? '')
  const [busy, setBusy] = useState<BrandAssetKind | null>(null)
  const [problems, setProblems] = useState<Partial<Record<IdentityStep, string>>>({})
  /** The colours of the logo on the page: the staged one's, else the saved one's. */
  const [logoColours, setLogoColours] = useState<{ source: string; colours: string[] } | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  /** Where the saved icon came from, when it was saved during this visit (see `IconOrigin`). */
  const [savedIcon, setSavedIcon] = useState<IconOrigin>(null)

  // Object URLs of staged pictures live as long as the page shows them.
  const urls = useRef(new Set<string>())
  useEffect(() => {
    const created = urls.current
    return () => {
      for (const url of created) URL.revokeObjectURL(url)
      created.clear()
    }
  }, [])
  const release = (draft: AssetDraft | undefined) => {
    if (!draft) return
    URL.revokeObjectURL(draft.url)
    urls.current.delete(draft.url)
  }
  const drop = (kinds: readonly BrandAssetKind[]) =>
    setAssets((current) => {
      const next = { ...current }
      for (const kind of kinds) {
        release(next[kind])
        delete next[kind]
      }
      return next
    })
  const stage = (kind: BrandAssetKind, prepared: PreparedAsset, origin: { generated: boolean; tile?: LetterTile }) => {
    const url = URL.createObjectURL(prepared.blob)
    urls.current.add(url)
    setAssets((current) => {
      release(current[kind])
      return { ...current, [kind]: { blob: prepared.blob, url, width: prepared.width, height: prepared.height, ...origin } }
    })
    return url
  }

  const save = useSaveCompanyIdentity(company.id, (step, saved) => {
    // What the server has is no longer the page's to save.
    if (step === 'color') {
      setColourText(saved.color ?? '')
      return
    }
    // The icon that was just saved is this visit's own: the page knows where it came from.
    if (step === 'icon' && assets.icon) setSavedIcon(originOf(assets.icon))
    drop([step])
  })
  const removeAssets = useRemoveBrandAssets(company.id)
  const resetColour = useResetBrandColour(company.id)

  // Without a staged logo, the suggestions come from the saved one (the API's own file, same origin).
  const savedLogo = brand.logo_url
  useEffect(() => {
    if (assets.logo || !savedLogo) return
    let cancelled = false
    void coloursOfLogo(savedLogo).then((colours) => {
      if (!cancelled) setLogoColours({ source: savedLogo, colours })
    })
    return () => {
      cancelled = true
    }
  }, [assets.logo, savedLogo])
  const logoOnPage = assets.logo?.url ?? savedLogo
  const suggested = logoColours && logoColours.source === logoOnPage ? logoColours.colours : []

  const colour = colourDraft(colourText, brand.color)
  // The preview follows the last colour that was one: half-typed text keeps the previous palette.
  const [previewColour, setPreviewColour] = useState<string | null>(brand.color)
  if (colour.valid && colour.value !== previewColour) setPreviewColour(colour.value)
  const debouncedColour = useDebouncedValue(previewColour, PALETTE_DEBOUNCE_MS)
  // The saved colour's palette came with the company: only another colour is asked for.
  const savedPalette = debouncedColour !== null && debouncedColour === brand.color ? brand.palette : null
  const palette = useBrandPalette(savedPalette ? null : debouncedColour)
  const shownPalette = debouncedColour === null ? null : (savedPalette ?? palette.data ?? null)
  /** The palette of a newer colour is on its way: what is shown is the previous one. */
  const paletteLoading = (palette.isFetching && !savedPalette) || debouncedColour !== previewColour
  /** The palette of the colour in the field is the one shown (none for no colour): what is drawn from it is drawn right. */
  const paletteKnown = !paletteLoading && (debouncedColour === null || shownPalette !== null)

  const changes = identityChanges(assets, colour)
  const dirty = changes !== null || !colour.valid
  const working = busy !== null || save.isPending || removeAssets.isPending || resetColour.isPending

  /** The icon on the page was chosen by hand during this visit: neither the logo nor the colour touches it. */
  const iconByHand = assets.icon ? !assets.icon.generated : savedIcon?.by === 'hand'
  const letter = iconLetter(company)
  const wantedTile = letterTileOf(letter, shownPalette)
  /** The letter tile on the page, when the icon is one the page drew: the staged one, else the one saved during this visit. */
  const tileOnPage = assets.icon ? (assets.icon.generated ? assets.icon.tile : undefined) : savedIcon?.by === 'page' ? (savedIcon.tile ?? undefined) : undefined
  const savedTile = savedIcon?.by === 'page' ? savedIcon.tile : null
  const stagedTile = assets.icon?.tile
  /** A tile that could not be drawn: it is not tried again until the colour changes, and it holds nothing back. */
  const [undrawnTile, setUndrawnTile] = useState<string | null>(null)
  const wantedSignature = JSON.stringify(wantedTile)
  const tileBehind = tileOnPage !== undefined && paletteKnown && !sameTile(tileOnPage, wantedTile) && undrawnTile !== wantedSignature
  /**
   * The letter tile on the page is not in the colour of the field yet: its palette is on its way, or
   * the tile is being drawn. "Save identity" waits for it, so the icon is never saved in the colour before.
   */
  const tileRedrawing = tileOnPage !== undefined && (paletteLoading || tileBehind)
  const tileSignature = tileBehind && busy === null && !save.isPending ? wantedSignature : null
  // The letter tile follows the colour: drawn again once the colour's palette is known.
  useEffect(() => {
    if (tileSignature === null) return
    const tile = JSON.parse(tileSignature) as LetterTile
    // Back at the colour the saved tile was drawn in: the saved icon is that tile already.
    if (stagedTile && savedTile && sameTile(savedTile, tile)) {
      drop(['icon'])
      return
    }
    let cancelled = false
    void letterIcon(tile)
      .then((icon) => {
        if (!cancelled) stage('icon', icon, { generated: true, tile })
      })
      // The tile on the page stays as it is; the next change of the colour draws it again.
      .catch(() => {
        if (!cancelled) setUndrawnTile(tileSignature)
      })
    return () => {
      cancelled = true
    }
    // `drop` and `stage` only set state; the tiles are compared by their words.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [tileSignature])

  /** The icon of a logo: the logo on a white tile, or for a wordmark the company's letter on its colour. */
  const iconOf = async (logo: PreparedAsset) => {
    if (logo.aspect > WORDMARK_MIN_RATIO && letter !== '') {
      // In the colour of the field when its palette is known; else on the neutral tile, and drawn again once it is.
      const tile = letterTileOf(letter, paletteKnown ? shownPalette : null)
      stage('icon', await letterIcon(tile), { generated: true, tile })
    } else {
      stage('icon', await iconFromLogo(logo.blob), { generated: true })
    }
  }

  const choose = async (kind: BrandAssetKind, file: File) => {
    setBusy(kind)
    setProblems((current) => ({ ...current, [kind]: undefined }))
    try {
      if (kind === 'icon') {
        stage('icon', await prepareIcon(file), { generated: false })
        return
      }
      const logo = await prepareLogo(file, kind === 'logo_dark' ? 'dark' : 'light')
      const url = stage(kind, logo, { generated: false })
      if (kind !== 'logo') return
      setLogoColours({ source: url, colours: logo.colours })
      // The icon follows the logo, unless one was chosen by hand on this page.
      if (!iconByHand) await iconOf(logo)
    } catch (error) {
      setProblems((current) => ({ ...current, [kind]: preparationProblem(error, kind) }))
    } finally {
      setBusy(null)
    }
  }

  const remove = (kind: BrandAssetKind) => {
    setProblems((current) => ({ ...current, [kind]: undefined }))
    if (assets[kind]) {
      // Only staged: nothing saved is lost. A staged logo takes the icon made from it along.
      drop(kind === 'logo' && assets.icon?.generated ? ['logo', 'icon'] : [kind])
      return
    }
    // The saved logo takes the saved icon with it, unless that icon was chosen by hand during this visit.
    const withIcon = kind === 'logo' && brand.icon_url !== null && !iconByHand
    setConfirmation({ type: 'remove', kind, kinds: withIcon ? ['logo', 'icon'] : [kind] })
  }

  const reset = () => {
    setProblems((current) => ({ ...current, color: undefined }))
    if (brand.color === null) {
      setColourText('')
      return
    }
    setConfirmation({ type: 'reset' })
  }

  const discard = () => {
    drop(BRAND_ASSET_KINDS)
    setColourText(brand.color ?? '')
    setProblems({})
  }

  const handleSave = () => {
    // The icon is still being drawn in the new colour: a moment later the button is itself again.
    if (tileRedrawing) return
    if (!colour.valid) {
      setProblems((current) => ({ ...current, color: t('identity.colour.invalid', { example: DEFAULT_THEME_COLORS.light }) }))
      document.getElementById(colourInputId)?.focus()
      return
    }
    if (!changes) return
    setProblems({})
    save.mutate(changes, {
      onSuccess: () => toast.show({ tone: 'success', title: t('identity.saved') }),
      onError: (error) => {
        const failed = error instanceof IdentitySaveError ? error : null
        const cause = failed ? failed.cause : error
        const message = failed && failed.step !== 'color' ? uploadProblem(cause) : getErrorMessage(cause)
        if (failed) setProblems((current) => ({ ...current, [failed.step]: failed.step === 'color' ? t('identity.colour.invalid', { example: DEFAULT_THEME_COLORS.light }) : message }))
        toast.show({ tone: 'danger', title: t('identity.saveFailed'), description: message })
      },
    })
  }

  const confirm = () => {
    if (!confirmation) return
    if (confirmation.type === 'reset') {
      resetColour.mutate(undefined, {
        onSuccess: () => {
          setConfirmation(null)
          setColourText('')
          toast.show({ tone: 'success', title: t('identity.resetDialog.done') })
        },
        onError: (error) => toast.show({ tone: 'danger', title: t('identity.resetDialog.failed'), description: getErrorMessage(error) }),
      })
      return
    }
    const { kind, kinds } = confirmation
    const withIcon = kind === 'logo' && kinds.includes('icon')
    removeAssets.mutate(kinds, {
      onSuccess: () => {
        setConfirmation(null)
        if (kinds.includes('icon')) setSavedIcon(null)
        // An icon the page had made from that logo and not saved yet goes with it too.
        if (kind === 'logo' && assets.icon?.generated) drop(['icon'])
        toast.show({ tone: 'success', title: t(withIcon ? 'identity.removeDialog.done.logoAndIcon' : `identity.removeDialog.done.${kind}`) })
      },
      onError: (error) => {
        // Of two files the first may be gone already: the page shows what is left, and the question is asked anew.
        if (kinds.length > 1) setConfirmation(null)
        toast.show({ tone: 'danger', title: t('identity.removeDialog.failed'), description: getErrorMessage(error) })
      },
    })
  }

  const confirming = removeAssets.isPending || resetColour.isPending
  const removal = confirmation?.type === 'remove' ? confirmation : null
  const removesIcon = removal !== null && removal.kind === 'logo' && removal.kinds.includes('icon')
  const slot = (kind: BrandAssetKind) => (
    <IdentityAssetSlot
      kind={kind}
      name={displayName}
      savedUrl={assetUrl(kind, {}, brand)}
      draft={assets[kind]}
      darkBackground={darkSurfaceOf(shownPalette)}
      busy={busy === kind}
      disabled={working}
      error={problems[kind]}
      onChoose={(file) => void choose(kind, file)}
      onRemove={() => remove(kind)}
    />
  )
  const link = signInLink(company.slug)

  return (
    <>
      <PageHeader
        title={t('identity.title')}
        // Whose identity this is: the company's logo and name head the page, and its name is in the tab's title.
        leading={<CompanyLogoTile company={company} size="lg" />}
        subject={displayName}
        documentTitle={[t('identity.title'), displayName].join(DATA_SEPARATOR)}
        back={{ to: paths.platformCompany(company.id), label: displayName }}
      />

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          handleSave()
        }}
        className="flex flex-col gap-6"
      >
        <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_23rem]">
          <div className="flex min-w-0 flex-col gap-6">
            <Card title={t('identity.logos.title')}>
              <div className="flex flex-col gap-6">
                {slot('logo')}
                <div className="grid grid-cols-1 gap-6 border-t border-border-subtle pt-6 sm:grid-cols-[minmax(0,1fr)_14rem]">
                  {slot('logo_dark')}
                  {slot('icon')}
                </div>
              </div>
            </Card>

            <Card title={t('identity.colour.title')}>
              <IdentityColourField
                inputId={colourInputId}
                value={colourText}
                onChange={(value) => {
                  setColourText(value)
                  setProblems((current) => ({ ...current, color: undefined }))
                }}
                suggested={suggested}
                fallback={DEFAULT_THEME_COLORS.light}
                error={problems.color}
                canReset={brand.color !== null || colourText.trim() !== ''}
                onReset={reset}
                disabled={save.isPending || confirming}
              />
            </Card>
          </div>

          <IdentityPreview
            name={displayName}
            brand={previewBrand(assets, brand)}
            palette={shownPalette}
            updating={(palette.isFetching && !savedPalette) || debouncedColour !== previewColour}
            className="xl:sticky xl:top-6"
          />

          <Card title={t('identity.link.title')} className="xl:col-start-1">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <ReadOnlyField label={t('identity.link.title')} className="min-w-0 flex-1 [&_dt]:sr-only">
                <span dir="ltr" data-sign-in-link="" className="text-align-parent block font-mono text-[0.875rem] break-all">
                  {link}
                </span>
              </ReadOnlyField>
              <CopyButton value={link} label={t('identity.link.copy')} copiedLabel={t('identity.link.copied')} />
            </div>
          </Card>
        </div>

        <StickyActionBar className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:flex-nowrap sm:justify-end">
          <p role="status" data-identity-status="" className="basis-full text-sm text-fg-muted sm:me-auto sm:basis-auto">
            {dirty ? t('identity.status.unsaved') : t('identity.status.saved')}
          </p>
          <Button variant="secondary" className="flex-1 sm:flex-none" icon={<Undo2 aria-hidden="true" />} disabled={!dirty || working} focusableWhenDisabled onClick={discard}>
            {t('identity.discard')}
          </Button>
          <Button type="submit" className="flex-1 sm:flex-none" icon={<Save aria-hidden="true" />} loading={save.isPending} disabled={!dirty || busy !== null || tileRedrawing} focusableWhenDisabled>
            {t('identity.save')}
          </Button>
        </StickyActionBar>
      </form>

      <Dialog
        open={confirmation !== null}
        role="alertdialog"
        onClose={() => setConfirmation(null)}
        dismissible={!confirming}
        title={removal ? t(`identity.removeDialog.title.${removal.kind}`) : t('identity.resetDialog.title')}
        // One line: what takes the removed picture's place, and for a logo that its icon goes with it.
        description={removal ? t(removesIcon ? 'identity.removeDialog.description.logoAndIcon' : `identity.removeDialog.description.${removal.kind}`) : t('identity.resetDialog.description')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmation(null)} disabled={confirming} focusableWhenDisabled>
              {t('identity.cancel')}
            </Button>
            <Button variant="danger" loading={confirming} onClick={confirm}>
              {removal ? t('identity.removeDialog.confirm') : t('identity.resetDialog.confirm')}
            </Button>
          </>
        }
      />

      <UnsavedChangesGuard dirty={dirty && !save.isPending} description={t('identity.unsavedDescription')} />
    </>
  )
}

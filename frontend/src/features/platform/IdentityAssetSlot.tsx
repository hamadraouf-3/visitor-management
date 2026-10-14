import { ImageUp, Trash2 } from 'lucide-react'
import { useRef, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { FieldMessages } from '../../components/ui/Field'
import { MetaLine } from '../../components/ui/MetaLine'
import { useStableId } from '../../hooks/useStableId'
import type { BrandAssetKind } from '../../identity/brand'
import { cn } from '../../utils/cn'
import { IMAGE_ACCEPT, type AssetDraft } from './identityForm'

export interface IdentityAssetSlotProps {
  kind: BrandAssetKind
  /** The company's name in the UI language (the preview's text alternative). */
  name: string
  /** The saved file's address, or null. */
  savedUrl: string | null
  /** The picture chosen on this page and not saved yet. */
  draft: AssetDraft | undefined
  /** The colour behind the dark-surface logo: the company's shell where that is dark, else its deep step (the default teal without a colour). */
  darkBackground?: string
  /** This slot's file is being prepared. */
  busy: boolean
  /** No file can be chosen now (another one is being prepared, a save is running). */
  disabled: boolean
  error?: string
  onChoose: (file: File) => void
  onRemove: () => void
}

/**
 * One file of a company's identity (Phase 12): what it is, how it looks where it is used (the logo
 * on white, the dark-surface logo on the shell's colour, the icon as a rounded tile), its size as a
 * fact, and "Choose image" or "Replace" and "Remove". The file is chosen with the browser's own
 * picker; whatever is chosen is prepared on this device (`identity/imagePipeline.ts`) before
 * anything is sent.
 */
export function IdentityAssetSlot({ kind, name, savedUrl, draft, darkBackground, busy, disabled, error, onChoose, onRemove }: IdentityAssetSlotProps) {
  const { t } = useTranslation('platform')
  const id = useStableId(`identity-${kind}`)
  const input = useRef<HTMLInputElement>(null)
  const label = t(`identity.logos.kinds.${kind}`)
  const url = draft?.url ?? savedUrl

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // The same file may be chosen again after a correction: the input forgets it.
    event.target.value = ''
    if (file) onChoose(file)
  }

  return (
    <div role="group" aria-labelledby={`${id}-label`} data-asset-slot={kind} className="flex min-w-0 flex-col gap-2.5">
      <p id={`${id}-label`} className="text-sm font-semibold text-fg">
        {label}
      </p>
      <div
        data-asset-preview={kind}
        className={cn(
          'flex items-center justify-center overflow-hidden border border-border',
          kind === 'icon' ? 'size-24 rounded-[1.25rem]' : 'h-32 rounded-control px-4 py-3',
          // A picture for light surfaces shows on white in either colour scheme; an empty slot is the page's own well.
          kind !== 'logo_dark' && (url ? 'bg-white' : 'bg-surface-sunken'),
        )}
        // The dark-surface logo on the colour it will stand on.
        style={kind === 'logo_dark' ? { backgroundColor: darkBackground } : undefined}
      >
        {url ? (
          <img
            src={url}
            alt={t('identity.logos.previewAlt', { slot: label, name })}
            decoding="async"
            draggable={false}
            className={cn('block object-contain', kind === 'icon' ? 'size-full' : 'max-h-full max-w-full')}
          />
        ) : (
          <span className={cn('text-sm', kind === 'logo_dark' ? 'text-white' : 'text-fg-muted')}>{t('identity.logos.none')}</span>
        )}
      </div>
      {draft && (
        <MetaLine
          className="text-meta text-fg-muted"
          items={[
            <span key="size" className="tabular-nums">
              {t('identity.logos.size', { width: draft.width, height: draft.height })}
            </span>,
            draft.generated ? t(draft.tile ? 'identity.logos.fromName' : 'identity.logos.fromLogo') : null,
            t('identity.logos.notSaved'),
          ]}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<ImageUp aria-hidden="true" />}
          loading={busy}
          disabled={disabled && !busy}
          focusableWhenDisabled
          aria-label={t(url ? 'identity.logos.replaceNamed' : 'identity.logos.chooseNamed', { slot: label })}
          aria-describedby={error ? `${id}-error` : undefined}
          onClick={() => input.current?.click()}
        >
          {busy ? t('identity.logos.preparing') : t(url ? 'identity.logos.replace' : 'identity.logos.choose')}
        </Button>
        {url && (
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 aria-hidden="true" />}
            disabled={disabled || busy}
            focusableWhenDisabled
            aria-label={t('identity.logos.removeNamed', { slot: label })}
            onClick={onRemove}
          >
            {t('identity.logos.remove')}
          </Button>
        )}
        {/* The browser's own file picker, opened by the button above; never a tab stop of its own. */}
        <input ref={input} type="file" accept={IMAGE_ACCEPT} hidden tabIndex={-1} data-asset-input={kind} onChange={handleFile} />
      </div>
      <div aria-live="polite">
        <FieldMessages error={error} errorId={`${id}-error`} />
      </div>
    </div>
  )
}

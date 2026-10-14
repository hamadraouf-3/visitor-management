import { Keyboard, ScanBarcode, X } from 'lucide-react'
import { useState, type FormEvent, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import { useStableId } from '../../hooks/useStableId'
import { cn } from '../../utils/cn'

export interface PassInputProps {
  /** `(pointer: coarse)`: the field starts collapsed behind a button, so no on-screen keyboard opens by itself. */
  coarse: boolean
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  /** A scan is running (the field keeps its text until it is taken). */
  busy: boolean
  /** Returns whether the pass was taken; the field is cleared then. */
  onSubmitPass: (value: string) => boolean
  /** Enter in the empty field: the result's primary action (§10 "Enter triggers the primary action"). */
  onEmptyEnter: () => void
  inputRef: RefObject<HTMLInputElement | null>
  toggleRef: RefObject<HTMLButtonElement | null>
  /**
   * The camera cannot scan (blocked, missing, failed): the entry is the way to scan, so the
   * collapsed button takes the primary style. It still does not open by itself.
   */
  emphasised?: boolean
}

/**
 * Handheld scanner and paste input (§10), direction C's bar under the camera: the label, the
 * field and "Check pass" in one row (the label above them on phones). A handheld scanner types
 * the pass like a keyboard and presses Enter. On fine-pointer devices the field is always shown
 * (and holds focus when nothing else does, see ScanPanel); on touch devices it is the collapsed
 * "Enter or paste pass" field.
 * Once open, the button that opened it gives way to a "Hide pass field" button in the field's
 * row, so the field has one control, not two. Every entry goes to the server, also one that is
 * not a valid pass, which answers PASS_INVALID and records the attempt (§6 row 1).
 */
export function PassInput({ coarse, expanded, onExpandedChange, busy, onSubmitPass, onEmptyEnter, inputRef, toggleRef, emphasised = false }: PassInputProps) {
  const { t } = useTranslation('reception')
  const [value, setValue] = useState('')
  const inputId = useStableId('pass-input')
  const regionId = `${inputId}-region`
  const shown = !coarse || expanded

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!value.trim()) {
      onEmptyEnter()
      return
    }
    if (onSubmitPass(value)) setValue('')
  }

  // Each button is replaced by the other, so focus moves to what takes its place: the field
  // (the tap opens the keyboard on purpose), or the "Enter or paste pass" button again. Both are
  // rendered synchronously first: a hidden or unmounted element cannot take focus.
  const open = () => {
    flushSync(() => onExpandedChange(true))
    inputRef.current?.focus()
  }
  const close = () => {
    flushSync(() => onExpandedChange(false))
    toggleRef.current?.focus()
  }

  return (
    <form noValidate onSubmit={handleSubmit} aria-label={t('passEntry.label')} className="flex flex-col">
      {coarse && !expanded && (
        <Button
          ref={toggleRef}
          variant={emphasised ? 'primary' : 'secondary'}
          size="lg"
          icon={<Keyboard aria-hidden="true" />}
          aria-expanded={false}
          aria-controls={regionId}
          onClick={open}
          className="w-full"
        >
          {t('passEntry.open')}
        </Button>
      )}
      <div
        id={regionId}
        hidden={!shown}
        className={cn(
          'flex flex-col gap-2 rounded-card border bg-surface p-2 sm:flex-row sm:items-center',
          emphasised ? 'border-accent-strong' : 'border-border',
        )}
      >
        <label htmlFor={inputId} className="flex shrink-0 items-center gap-2 px-2 pt-1 text-sm font-medium text-fg-secondary sm:pt-0">
          <ScanBarcode aria-hidden="true" className="size-5 shrink-0 text-fg-muted" />
          {t('passEntry.field')}
        </label>
        <div className="flex min-w-0 flex-1 gap-2">
          <Input
            ref={inputRef}
            id={inputId}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            inputMode="url"
            enterKeyHint="go"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            dir="ltr"
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="secondary" loading={busy} className="shrink-0">
            {t('passEntry.submit')}
          </Button>
          {coarse && (
            <Button
              variant="ghost"
              icon={<X aria-hidden="true" />}
              aria-expanded
              aria-controls={regionId}
              onClick={close}
              title={t('passEntry.hide')}
              className="shrink-0 px-3 pointer-coarse:min-w-11"
            >
              <span className="sr-only">{t('passEntry.hide')}</span>
            </Button>
          )}
        </div>
      </div>
    </form>
  )
}

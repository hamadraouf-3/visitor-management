import { Eye, FileText } from 'lucide-react'
import { Fragment, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert } from '../../components/ui/Alert'
import { ApiErrorMessage } from '../../components/ui/ApiErrorMessage'
import { Card } from '../../components/ui/Card'
import { RadioGroup } from '../../components/ui/RadioGroup'
import { Spinner } from '../../components/ui/Spinner'
import { TabPanel, Tabs } from '../../components/ui/Tabs'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { directionOf, type Language } from '../../i18n'
import type { EmailScheme, EmailTemplate, EmailTemplatePreviewRequest } from '../../types/api'
import { cn } from '../../utils/cn'
import { previewSubjectParts, previewTextSections, SUBJECT_SEPARATOR, TEMPLATE_LANGUAGES, toPreviewRequest, type TemplateDraft } from './emailTemplateForm'
import { useEmailTemplatesSource } from './emailTemplatesSource'
import { useEmailTemplatePreview } from './queries'

type PreviewTab = 'draft' | 'saved'

/** The schemes the e-mail can be previewed in, as offered (Phase 13): light first, the e-mail as sent. */
const EMAIL_SCHEMES: readonly EmailScheme[] = ['light', 'dark']

/** How long the draft must stay unchanged before it is rendered again. */
export const PREVIEW_DEBOUNCE_MS = 600

export interface EmailPreviewCardProps {
  template: EmailTemplate
  draft: TemplateDraft
  /** The draft has a problem: it is not rendered (the fields say what). */
  draftInvalid: boolean
  /** The language that leads the e-mail shown here; the editor's "Send test" sends that same e-mail. */
  language: Language
  onLanguageChange: (language: Language) => void
}

type DraftPreviewProps = Omit<EmailPreviewCardProps, 'onLanguageChange'>

/**
 * The draft's subject and text version (POST preview). The e-mail has two sections, the leading
 * language's and the other's: each line is set in the direction of the section it stands in and
 * carries that language (`lang`), whatever script a name or a value in it is written in.
 */
function DraftPreview({ template, draft, draftInvalid, language }: DraftPreviewProps) {
  const { t } = useTranslation('admin')
  // Debounced as text: a new body object every render would never settle. Without a scheme: the subject
  // and the text version have no colours, so the saved e-mail's Light / Dark asks nothing new here.
  const json = useDebouncedValue(draftInvalid ? null : JSON.stringify(toPreviewRequest(template, draft, language)), PREVIEW_DEBOUNCE_MS)
  const body = useMemo(() => (json === null ? null : (JSON.parse(json) as EmailTemplatePreviewRequest)), [json])
  const preview = useEmailTemplatePreview(template.kind, draftInvalid ? null : body)

  if (draftInvalid) return <Alert tone="warning" title={t('emailTemplates.invalid')} />
  if (preview.isError && !preview.data)
    return (
      <Alert tone="danger" title={t('emailTemplates.preview.loadError')}>
        <ApiErrorMessage error={preview.error} />
      </Alert>
    )
  if (!preview.data) return <Spinner label={t('emailTemplates.preview.updating')} showLabel />

  // The rendering on screen says which language leads it: it may still be the previous one while the next loads.
  const lead = preview.data.language
  return (
    <div className="flex flex-col gap-4" aria-busy={preview.isFetching || undefined}>
      <div className="rounded-control border border-border-subtle bg-surface-sunken px-4 py-3">
        <p className="text-xs font-semibold text-fg-muted">{t('emailTemplates.preview.subject')}</p>
        <p dir={directionOf(lead)} className="mt-1 text-[0.96875rem] font-semibold break-words text-fg" data-preview-subject="">
          {previewSubjectParts(preview.data.subject, lead).map((part, index) => (
            <Fragment key={part.language}>
              {index > 0 && SUBJECT_SEPARATOR}
              <bdi lang={part.language} dir={directionOf(part.language)}>
                {part.text}
              </bdi>
            </Fragment>
          ))}
        </p>
      </div>
      <div>
        <p className="mb-2 flex items-center gap-2 text-xs font-semibold text-fg-muted">
          {t('emailTemplates.preview.text')}
          {preview.isFetching && <Spinner size="sm" label={t('emailTemplates.preview.updating')} />}
        </p>
        {/* At its full height: a box that scrolled on its own would need a tab stop (axe scrollable-region-focusable). */}
        <div data-preview-text="" className="rounded-control border border-border-subtle bg-surface px-4 py-3 text-sm leading-relaxed text-fg">
          {previewTextSections(preview.data.text, lead).map((section, sectionIndex) => (
            <div key={sectionIndex} lang={section.language} dir={directionOf(section.language)} data-preview-section={section.language}>
              {section.lines.map((line, index) =>
                line.trim() === '' ? (
                  <div key={index} aria-hidden="true" className="h-3" />
                ) : (
                  <p key={index} className="break-words whitespace-pre-wrap">
                    {line}
                  </p>
                ),
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * The e-mail as it will be sent, with sample data (B11-28): the draft (subject and text version,
 * rendered by POST preview from the unsaved texts) and the saved e-mail exactly as a mail client
 * shows it (GET preview: a document with its own sandbox policy in a sandboxed frame; the SPA's
 * own style policy would strip the e-mail's inline styles anywhere else). Either language may lead:
 * the editor holds the choice, since its "Send test" sends the e-mail this card shows.
 *
 * Light / Dark (Phase 13): the saved e-mail as it is sent, or as a mail client in its dark mode shows
 * it (the server applies the e-mail's dark design: `scheme`), whatever this device's own appearance.
 * Light by default. What the e-mail shows is the server's to decide: a frame's document sees the
 * viewer's own device scheme (`prefers-color-scheme`) whatever the frame says, so each scheme is asked
 * for by name. The frame itself (its canvas while the document loads, its scrollbars) takes the scheme.
 */
export function EmailPreviewCard({ template, draft, draftInvalid, language, onLanguageChange }: EmailPreviewCardProps) {
  const { t } = useTranslation(['admin', 'common'])
  const [tab, setTab] = useState<PreviewTab>('draft')
  const [scheme, setScheme] = useState<EmailScheme>('light')
  const source = useEmailTemplatesSource()
  const idBase = useId()
  const languageName = (code: Language) => t(`emailTemplates.languages.${code}`)

  return (
    <Card title={t('emailTemplates.preview.title')} titleId={`${idBase}-title`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs<PreviewTab>
          idBase={`${idBase}-tabs`}
          label={t('emailTemplates.preview.tabsLabel')}
          value={tab}
          onValueChange={setTab}
          items={[
            { value: 'draft', label: <span className="inline-flex items-center gap-1.5"><FileText aria-hidden="true" className="size-4" />{t('emailTemplates.preview.draft')}</span> },
            { value: 'saved', label: <span className="inline-flex items-center gap-1.5"><Eye aria-hidden="true" className="size-4" />{t('emailTemplates.preview.saved')}</span> },
          ]}
        />
        {/* The leading language: the visible words are the group's legend, read once (the legend itself is for assistive technology). */}
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="text-sm font-semibold text-fg-secondary">
            {t('emailTemplates.preview.firstLanguage')}
          </span>
          <RadioGroup<Language>
            label={<span className="sr-only">{t('emailTemplates.preview.firstLanguage')}</span>}
            variant="segmented"
            value={language}
            onValueChange={onLanguageChange}
            options={TEMPLATE_LANGUAGES.map((code) => ({ value: code, label: languageName(code) }))}
            className="[&_legend]:mb-0"
          />
        </div>
      </div>
      <TabPanel idBase={`${idBase}-tabs`} value="draft" selected={tab}>
        <DraftPreview template={template} draft={draft} draftInvalid={draftInvalid} language={language} />
      </TabPanel>
      <TabPanel idBase={`${idBase}-tabs`} value="saved" selected={tab}>
        <div className="flex flex-col gap-3">
          {/* Light / Dark: the e-mail as sent, or as a mail client in its dark mode shows it. */}
          <RadioGroup<EmailScheme>
            label={<span className="sr-only">{t('emailTemplates.preview.scheme')}</span>}
            variant="segmented"
            value={scheme}
            onValueChange={setScheme}
            options={EMAIL_SCHEMES.map((value) => ({ value, label: t(`common:appearance.${value}`) }))}
            className="self-end [&_legend]:mb-0"
          />
          <iframe
            // A new document after every save or reset (the response is never cached: no-store), and for each scheme.
            key={`${template.updated_at ?? 'product'}-${language}-${scheme}`}
            sandbox=""
            src={source.api.previewUrl(template.kind, { language, scheme })}
            title={t('emailTemplates.preview.frameTitle', { language: languageName(language) })}
            data-saved-preview=""
            data-scheme-preview={scheme}
            className={cn(
              'h-[44rem] w-full rounded-control border border-border-subtle',
              // The e-mail's own canvas while it loads: white, or the dark design's (the app's dark canvas).
              scheme === 'dark' ? 'bg-ink-950 scheme-dark' : 'bg-white scheme-light',
            )}
          />
        </div>
      </TabPanel>
    </Card>
  )
}

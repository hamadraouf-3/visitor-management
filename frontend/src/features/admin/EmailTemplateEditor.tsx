import { RotateCcw, Save, Send, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getErrorMessage, getFieldErrorCodes, hasErrorCode, rateLimitWaitSeconds } from '../../api/client'
import { Alert } from '../../components/ui/Alert'
import { Button } from '../../components/ui/Button'
import { Dialog } from '../../components/ui/Dialog'
import { MetaLine } from '../../components/ui/MetaLine'
import { PageHeader } from '../../components/ui/PageHeader'
import { StickyActionBar } from '../../components/ui/StickyActionBar'
import { useToast } from '../../components/ui/toastContext'
import { useStableId } from '../../hooks/useStableId'
import type { Language } from '../../i18n'
import { useLanguage } from '../../i18n/useLanguage'
import type { EmailTemplate, EmailTemplateFieldName } from '../../types/api'
import { formatDateTime } from '../../utils/datetime'
import { formatWaitDuration } from '../../utils/duration'
import { focusFirstControl } from '../../utils/focus'
import { resolveServerErrors, type ServerFieldPaths } from '../../utils/forms'
import { DATA_SEPARATOR } from '../../utils/text'
import { EmailPreviewCard } from './EmailPreviewCard'
import {
  draftFromTemplate,
  draftProblems,
  refusedSavedTexts,
  serverProblemMessage,
  fieldKey,
  fieldVariables,
  insertVariable,
  TEMPLATE_LANGUAGES,
  templateProblemMessage,
  templateRecipient,
  toPreviewRequest,
  toTemplateUpdate,
  type TemplateDraft,
  type TemplateFieldKey,
} from './emailTemplateForm'
import { useEmailTemplatesSource } from './emailTemplatesSource'
import { useResetEmailTemplate, useSaveEmailTemplate, useSendTestEmail } from './queries'
import { TemplateTextField } from './TemplateTextField'
import { UnsavedChangesGuard } from './UnsavedChangesGuard'

type Control = HTMLInputElement | HTMLTextAreaElement

export interface EmailTemplateEditorProps {
  template: EmailTemplate
}

/**
 * The editor of one e-mail's texts (B11-20 … B11-29), laid out by field: each field is a row with
 * its Arabic text (right to left) and its English text (left to right), side by side from `md` and
 * one directly under the other on phones, so whoever translates a field has both in view (they were
 * two whole blocks, about 1,400 px apart on a phone: UX review L8). Each text has the product's as
 * its placeholder, the variables to insert and the server's checks while typing. Save sends only
 * what changed (all or nothing on the server, whose 422 lands on the same texts); "Reset to default"
 * after one line; "Send test" mails the draft to whoever sends it (the administrator; the platform
 * owner on the platform's pages) as the preview shows it; the preview shows the draft and the saved
 * e-mail. Whose texts, and through which endpoints, is the page's source (`emailTemplatesSource.ts`).
 */
export function EmailTemplateEditor({ template }: EmailTemplateEditorProps) {
  const { t } = useTranslation('admin')
  const source = useEmailTemplatesSource()
  const { language: uiLanguage } = useLanguage()
  const toast = useToast()
  const idBase = useStableId('template')
  const save = useSaveEmailTemplate(template.kind)
  const reset = useResetEmailTemplate(template.kind)
  const sendTest = useSendTestEmail(template.kind)
  const [draft, setDraft] = useState<TemplateDraft>(() => draftFromTemplate(template))
  /** Texts edited since the last save: their problems show while typing. */
  const [edited, setEdited] = useState<ReadonlySet<TemplateFieldKey>>(new Set())
  /** A save or a test was refused by the client's checks: every problem shows. */
  const [attempted, setAttempted] = useState(false)
  /** The last refusal of the server (a save or a test) and the texts edited since it. */
  const [serverError, setServerError] = useState<unknown>(null)
  const [editedSinceServerError, setEditedSinceServerError] = useState<ReadonlySet<TemplateFieldKey>>(new Set())
  /** The language that leads the previewed e-mail, and so the test e-mail: one choice for both. */
  const [leadLanguage, setLeadLanguage] = useState<Language>(uiLanguage)
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [focusRequest, setFocusRequest] = useState<{ ids: string[] } | null>(null)
  const controls = useRef(new Map<TemplateFieldKey, Control>())
  const caretRequest = useRef<{ key: TemplateFieldKey; caret: number } | null>(null)

  const controlId = (key: TemplateFieldKey) => `${idBase}-${key.replace('.', '-')}`
  const update = toTemplateUpdate(template, draft)
  const dirty = update !== null
  const problems = draftProblems(template, draft)
  // A saved text that a newer rule refuses is not used by the e-mails: its problem shows before anyone types.
  const refusedSaved = new Set(refusedSavedTexts(template))
  // In the order the page reads: field by field, each one's Arabic text, then its English one.
  const keys = template.fields.flatMap((field) => TEMPLATE_LANGUAGES.map((language) => fieldKey(language, field.name)))
  const serverPaths = Object.fromEntries(keys.map((key) => [key, key])) as ServerFieldPaths<TemplateFieldKey>
  const server = resolveServerErrors(serverError, serverPaths)
  const serverCodes = getFieldErrorCodes(serverError)

  const errorOf = (key: TemplateFieldKey): string | undefined => {
    const problem = problems[key]
    if (problem && (attempted || edited.has(key) || refusedSaved.has(key))) return templateProblemMessage(problem)
    const refusal = server.fieldErrors[key]
    if (refusal === undefined || editedSinceServerError.has(key)) return undefined
    return serverProblemMessage(refusal, serverCodes[key])
  }

  useEffect(() => {
    if (focusRequest) focusFirstControl(focusRequest.ids)
  }, [focusRequest])

  // After a variable is inserted: the caret goes after it, in the text it went into.
  useEffect(() => {
    const request = caretRequest.current
    if (!request) return
    caretRequest.current = null
    const control = controls.current.get(request.key)
    control?.focus()
    control?.setSelectionRange(request.caret, request.caret)
  })

  const setText = (language: Language, field: EmailTemplateFieldName, value: string) => {
    const key = fieldKey(language, field)
    setDraft((current) => ({ ...current, [language]: { ...current[language], [field]: value } }))
    setEdited((current) => new Set(current).add(key))
    setEditedSinceServerError((current) => new Set(current).add(key))
  }

  const insert = (language: Language, field: EmailTemplateFieldName, name: string) => {
    const key = fieldKey(language, field)
    const control = controls.current.get(key)
    const value = draft[language][field] ?? ''
    const next = insertVariable(value, control?.selectionStart ?? null, control?.selectionEnd ?? null, name)
    caretRequest.current = { key, caret: next.caret }
    setText(language, field, next.value)
  }

  /** The client's checks before a request: false (and the first problem focused) when any text has one. */
  const checkDraft = (): boolean => {
    const invalid = keys.filter((key) => problems[key])
    if (invalid.length === 0) return true
    setAttempted(true)
    setFocusRequest({ ids: invalid.map(controlId) })
    return false
  }

  const refused = (error: unknown) => {
    setServerError(error)
    setEditedSinceServerError(new Set())
    const fields = Object.keys(resolveServerErrors(error, serverPaths).fieldErrors) as TemplateFieldKey[]
    if (fields.length > 0) setFocusRequest({ ids: keys.filter((key) => fields.includes(key)).map(controlId) })
  }

  const startOver = (saved: EmailTemplate) => {
    setDraft(draftFromTemplate(saved))
    setEdited(new Set())
    setAttempted(false)
    setServerError(null)
  }

  const handleSave = () => {
    if (!update || !checkDraft()) return
    save.mutate(update, {
      onSuccess: (saved) => {
        startOver(saved)
        toast.show({ tone: 'success', title: t('emailTemplates.saved') })
      },
      onError: refused,
    })
  }

  /** The draft to the administrator's own address, the language the preview shows first leading it (it was the UI's: UX review L6). */
  const handleTest = () => {
    if (!checkDraft()) return
    sendTest.mutate(toPreviewRequest(template, draft, leadLanguage), {
      onSuccess: (sent) => toast.show({ tone: 'success', title: t('emailTemplates.test.sent'), description: t('emailTemplates.test.sentTo', { email: sent.sent_to }) }),
      onError: (error) => {
        if (hasErrorCode(error, 'VALIDATION_ERROR')) {
          refused(error)
          return
        }
        const wait = rateLimitWaitSeconds(error)
        const description = wait !== null ? t('emailTemplates.test.limited', { duration: formatWaitDuration(wait) }) : getErrorMessage(error)
        toast.show({ tone: 'danger', title: t('emailTemplates.test.action'), description })
      },
    })
  }

  const handleReset = () =>
    reset.mutate(undefined, {
      onSuccess: (saved) => {
        setConfirmingReset(false)
        startOver(saved)
        toast.show({ tone: 'success', title: t('emailTemplates.reset.done') })
      },
      onError: (error) => toast.show({ tone: 'danger', title: t('emailTemplates.reset.action'), description: getErrorMessage(error) }),
    })

  const kindName = t(`emailTemplates.kinds.${template.kind}`)
  const customised = template.fields.some((field) => field.override.ar !== null || field.override.en !== null)

  return (
    <>
      <PageHeader
        title={kindName}
        back={{ to: source.listPath, label: t('emailTemplates.back') }}
        // On the platform owner's pages: whose e-mail this is, above its name and in the tab's title.
        leading={source.owner?.leading}
        subject={source.owner?.name}
        documentTitle={source.owner ? [kindName, source.owner.name].join(DATA_SEPARATOR) : undefined}
        meta={
          <MetaLine
            stackOnPhones
            items={[
              t(`emailTemplates.recipients.${templateRecipient(template.kind)}`),
              template.updated_at ? t('emailTemplates.changedAt', { date: formatDateTime(template.updated_at, source.timeZone) }) : t('emailTemplates.productTexts'),
            ]}
          />
        }
        actions={
          <>
            <Button variant="secondary" icon={<Send aria-hidden="true" className="mirror-rtl" />} loading={sendTest.isPending} onClick={handleTest}>
              {t('emailTemplates.test.action')}
            </Button>
            <Button variant="secondary" icon={<RotateCcw aria-hidden="true" />} disabled={!customised} focusableWhenDisabled onClick={() => setConfirmingReset(true)}>
              {t('emailTemplates.reset.action')}
            </Button>
          </>
        }
      />

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          handleSave()
        }}
        className="flex flex-col gap-6"
      >
        {server.formError && <Alert tone="danger">{server.formError}</Alert>}
        <div className="rounded-card border border-border bg-surface">
          {template.fields.map((field) => {
            const headingId = `${idBase}-${field.name}-heading`
            return (
              // A group, not a section: seven labelled sections would be seven landmarks.
              <div
                key={field.name}
                role="group"
                aria-labelledby={headingId}
                data-template-row={field.name}
                className="border-b border-border-subtle px-4 py-4 last:border-b-0 sm:px-5 sm:py-5"
              >
                <h2 id={headingId} className="mb-2 text-section font-bold text-fg sm:mb-3">
                  {t(`emailTemplates.fields.${field.name}`)}
                </h2>
                <div className="grid grid-cols-1 items-start gap-x-6 gap-y-4 md:grid-cols-2">
                  {TEMPLATE_LANGUAGES.map((language) => {
                    const key = fieldKey(language, field.name)
                    return (
                      <TemplateTextField
                        key={language}
                        id={controlId(key)}
                        language={language}
                        field={field}
                        value={draft[language][field.name] ?? ''}
                        onChange={(value) => setText(language, field.name, value)}
                        variables={fieldVariables(field, template.variables)}
                        onInsert={(name) => insert(language, field.name, name)}
                        saved={field.override[language] !== null}
                        error={errorOf(key)}
                        controlRef={(element) => {
                          if (element) controls.current.set(key, element)
                          else controls.current.delete(key)
                        }}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>

        <EmailPreviewCard
          template={template}
          draft={draft}
          draftInvalid={Object.keys(problems).length > 0}
          language={leadLanguage}
          onLanguageChange={setLeadLanguage}
        />

        <StickyActionBar className="flex flex-wrap items-center gap-x-3 gap-y-2 sm:flex-nowrap sm:justify-end">
          <p role="status" className="basis-full text-sm text-fg-muted sm:me-auto sm:basis-auto">
            {dirty ? t('emailTemplates.status.unsaved') : t('emailTemplates.status.saved')}
          </p>
          <Button
            variant="secondary"
            className="flex-1 sm:flex-none"
            icon={<Undo2 aria-hidden="true" />}
            disabled={!dirty || save.isPending}
            focusableWhenDisabled
            onClick={() => startOver(template)}
          >
            {t('emailTemplates.discard')}
          </Button>
          <Button type="submit" className="flex-1 sm:flex-none" icon={<Save aria-hidden="true" />} loading={save.isPending} disabled={!dirty} focusableWhenDisabled>
            {t('emailTemplates.save')}
          </Button>
        </StickyActionBar>
      </form>

      <Dialog
        open={confirmingReset}
        role="alertdialog"
        onClose={() => setConfirmingReset(false)}
        dismissible={!reset.isPending}
        title={t('emailTemplates.reset.title')}
        description={t('emailTemplates.reset.description')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmingReset(false)} disabled={reset.isPending} focusableWhenDisabled>
              {t('users.cancel')}
            </Button>
            <Button variant="danger" loading={reset.isPending} onClick={handleReset}>
              {t('emailTemplates.reset.confirm')}
            </Button>
          </>
        }
      />

      <UnsavedChangesGuard dirty={dirty && !save.isPending && !reset.isPending} description={t('emailTemplates.unsavedDescription')} />
    </>
  )
}

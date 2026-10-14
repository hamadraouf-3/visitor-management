import { Check, Circle, CircleAlert, PencilLine, Plus, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '../../components/ui/Badge'
import { Input } from '../../components/ui/Input'
import { Textarea } from '../../components/ui/Textarea'
import { useRovingToolbar } from '../../hooks/useRovingToolbar'
import { directionOf, type Language } from '../../i18n'
import { cn } from '../../utils/cn'
import { placeholdersOf, textLength, variableLabel, type TemplateField } from './emailTemplateForm'

/**
 * "Edit default text" / "Use default" above a text. On touch screens it is 44 px tall without making
 * its row taller (negative margins: it reaches into the free room above and below the row), so the
 * row is one height with or without it: a text that gains "Use default" when typed into does not
 * push the form down, and fourteen rows do not each cost a phone 16 px.
 */
const DEFAULT_TEXT_BUTTON =
  'inline-flex min-h-7 items-center gap-1 rounded-item px-1.5 text-[0.8125rem] font-semibold text-accent-text hover:bg-surface-muted pointer-coarse:-my-2 pointer-coarse:min-h-11'

interface VariableToolbarProps {
  /** The toolbar's name: which text its variables go into ("Variables: Subject (Arabic)"). */
  label: string
  /** The id of that text's control. */
  controls: string
  variables: readonly string[]
  /** The variables the text holds already: their chips are marked. */
  used: readonly string[]
  onInsert: (name: string) => void
}

/**
 * The variables of a text as chips: a toolbar (WAI-ARIA APG), so the eight of them are one tab stop
 * after the text, with the arrow keys between them. Always there under its text, at one place: the
 * chips once moved with the field being edited, and the form jumped under the pointer (UX review M6,
 * L7). Touch screens show them as one row that scrolls sideways (44 px chips in three rows under
 * each of fourteen texts made the page a third longer).
 */
function VariableToolbar({ label, controls, variables, used, onInsert }: VariableToolbarProps) {
  const { t } = useTranslation('admin')
  const toolbar = useRovingToolbar(variables.length)
  return (
    <div
      {...toolbar.toolbarProps}
      aria-label={label}
      aria-controls={controls}
      data-template-variables=""
      className={cn(
        'scroll-shadow-x flex flex-wrap items-center gap-1.5 [--scroll-shadow-cover:var(--color-surface)]',
        // One scrolling row on touch screens; the padding keeps the chips' focus rings inside the scroll box.
        'pointer-coarse:-m-1 pointer-coarse:flex-nowrap pointer-coarse:overflow-x-auto pointer-coarse:p-1',
      )}
    >
      <span aria-hidden="true" className="me-0.5 text-xs font-semibold text-fg-muted pointer-coarse:hidden">
        {t('emailTemplates.variables')}
      </span>
      {variables.map((name, index) => {
        const variable = variableLabel(name)
        return (
          <button
            key={name}
            type="button"
            {...toolbar.itemProps(index)}
            // Keeps the caret in the text while a pointer inserts (the keyboard reaches the chips by Tab: the caret stays where it was).
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onInsert(name)}
            aria-label={t('emailTemplates.insertVariable', { variable })}
            title={`{${name}}`}
            className={cn(
              'inline-flex min-h-7 shrink-0 items-center gap-1 rounded-full border border-border px-2 text-[0.8125rem] font-medium whitespace-nowrap text-fg-secondary transition-colors',
              'hover:border-accent-border hover:bg-accent-surface hover:text-accent-text pointer-coarse:min-h-11 pointer-coarse:px-3',
              used.includes(name) && 'border-accent-border text-accent-text',
            )}
          >
            <Plus aria-hidden="true" className="size-3.5 shrink-0" />
            {variable}
          </button>
        )
      })}
    </div>
  )
}

export interface TemplateTextFieldProps {
  id: string
  /** The language the text is written in: its direction and `lang` (an Arabic text is right to left, an English one left to right). */
  language: Language
  field: TemplateField
  value: string
  onChange: (value: string) => void
  /** The variables this text may hold (the kind's, without those the field forbids), offered as chips under the text. */
  variables: readonly string[]
  /** Inserts `{name}` where the caret (or the selection) was. */
  onInsert: (name: string) => void
  /** The company has its own text saved for this field. */
  saved: boolean
  error?: string
  /** Registers the control, for inserting at its caret and focusing it. */
  controlRef: (element: HTMLInputElement | HTMLTextAreaElement | null) => void
}

/**
 * One text of an e-mail in one language, a cell of its field's row (the row's heading names the
 * field): the language as its visible label ("Changed" beside it when the company has its own text;
 * the accessible name says both, "Subject (Arabic)"), the product's text as the placeholder, "Use
 * default" (empty the text: the product's applies) or "Edit default text" (start from it), the
 * variables to insert, the required variable as a rule with its state, the character count and the
 * error.
 */
export function TemplateTextField({ id, language, field, value, onChange, variables, onInsert, saved, error, controlRef }: TemplateTextFieldProps) {
  const { t } = useTranslation(['admin', 'common', 'auth'])
  const languageName = t(`emailTemplates.languages.${language}`)
  // Both languages have every field: the accessible names say which one ("Subject (English)").
  const label = t('emailTemplates.fieldIn', { field: t(`emailTemplates.fields.${field.name}`), language: languageName })
  const defaultText = field.default[language]
  const empty = value.trim() === ''
  const used = placeholdersOf(value)
  const countId = `${id}-count`
  const ruleId = field.required_variables.length > 0 ? `${id}-rule` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [ruleId, countId, errorId].filter(Boolean).join(' ')

  const control = {
    id,
    dir: directionOf(language),
    lang: language,
    value,
    placeholder: defaultText || undefined,
    invalid: Boolean(error),
    'aria-describedby': describedBy,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    spellCheck: true,
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-template-field={`${language}.${field.name}`}>
      {/* One height on every pointer, with or without a button; 8 px above the text on touch screens, the room the button's touch area takes. */}
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1 pointer-coarse:mb-0.5">
        <span className="flex items-center gap-2">
          <label htmlFor={id} className="text-sm font-semibold text-fg">
            <span aria-hidden="true">{languageName}</span>
            <span className="sr-only">{label}</span>
          </label>
          {saved && <Badge tone="accent">{t('emailTemplates.custom')}</Badge>}
        </span>
        {/* Each name starts with the words on the button (WCAG 2.5.3), then says which text. */}
        {!empty ? (
          <button type="button" onClick={() => onChange('')} aria-label={t('emailTemplates.useDefaultFor', { field: label })} className={DEFAULT_TEXT_BUTTON}>
            <RotateCcw aria-hidden="true" className="size-3.5" />
            {t('emailTemplates.useDefault')}
          </button>
        ) : (
          defaultText && (
            <button type="button" onClick={() => onChange(defaultText)} aria-label={t('emailTemplates.editDefaultFor', { field: label })} className={DEFAULT_TEXT_BUTTON}>
              <PencilLine aria-hidden="true" className="size-3.5" />
              {t('emailTemplates.editDefault')}
            </button>
          )
        )}
      </div>
      {field.multiline ? (
        <Textarea ref={controlRef} rows={field.max_length > 400 ? 5 : 3} {...control} />
      ) : (
        <Input ref={controlRef} autoComplete="off" {...control} />
      )}
      {variables.length > 0 && <VariableToolbar label={t('emailTemplates.variablesFor', { field: label })} controls={id} variables={variables} used={used} onInsert={onInsert} />}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 text-[0.8125rem] text-fg-muted">
        {ruleId ? (
          <ul id={ruleId} className="flex flex-col gap-0.5">
            {field.required_variables.map((name) => {
              const met = empty || used.includes(name)
              return (
                <li key={name} className={cn('flex items-center gap-1.5', met ? 'text-success-text' : 'text-fg-muted')}>
                  {met ? <Check aria-hidden="true" className="size-3.5 shrink-0" /> : <Circle aria-hidden="true" className="size-3.5 shrink-0" />}
                  <span>
                    {t('emailTemplates.mustInclude', { variable: variableLabel(name) })}
                    <span className="sr-only">{met ? t('auth:password.met') : t('auth:password.notMet')}</span>
                  </span>
                </li>
              )
            })}
          </ul>
        ) : (
          <span />
        )}
        <span id={countId} className={cn('tabular-nums', textLength(value) > field.max_length && 'font-semibold text-danger-text')}>
          {t('common:text.characterCount', { count: field.max_length, length: textLength(value) })}
        </span>
      </div>
      {error && (
        <p id={errorId} className="flex items-start gap-1.5 text-sm font-medium text-danger-text">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}

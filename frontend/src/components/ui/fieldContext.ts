import { createContext, useContext } from 'react'

/** Wiring a <Field> provides to the single control inside it. */
export interface FieldControlContext {
  id: string
  describedBy: string | undefined
  invalid: boolean
  required: boolean
}

export const FieldContext = createContext<FieldControlContext | null>(null)

export function useFieldControl(): FieldControlContext | null {
  return useContext(FieldContext)
}

function joinIds(...ids: (string | undefined)[]): string | undefined {
  const joined = ids.filter(Boolean).join(' ')
  return joined || undefined
}

/**
 * Accessibility attributes for a form control: explicit props win, otherwise the
 * surrounding Field supplies id, aria-describedby (hint + error), aria-invalid, aria-required.
 */
export function useControlA11yProps(props: {
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling'
  'aria-required'?: boolean | 'true' | 'false'
  invalid?: boolean
}) {
  const field = useFieldControl()
  const invalid = props.invalid ?? field?.invalid ?? false
  return {
    id: props.id ?? field?.id,
    'aria-describedby': joinIds(field?.describedBy, props['aria-describedby']),
    'aria-invalid': props['aria-invalid'] ?? (invalid || undefined),
    'aria-required': props['aria-required'] ?? (field?.required || undefined),
  }
}

/**
 * Shared look of text-like controls (direction C): 44 px tall with a 12 px radius. The border is
 * the 3:1 control boundary (border-strong). 16 px text prevents iOS zoom on focus.
 */
export const controlClassName =
  'block w-full min-h-11 rounded-control border border-border-strong bg-surface px-3.5 py-2 text-base text-fg ' +
  'placeholder:text-fg-placeholder disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-fg-muted ' +
  'aria-[invalid=true]:border-danger-solid aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-danger-solid'

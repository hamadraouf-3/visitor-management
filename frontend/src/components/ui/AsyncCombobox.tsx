import { keepPreviousData, useQuery, type QueryKey } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getErrorMessage } from '../../api/client'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { Combobox, type ComboboxProps } from './Combobox'

export interface AsyncComboboxProps<T>
  extends Omit<ComboboxProps<T>, 'options' | 'loading' | 'errorMessage' | 'idleMessage' | 'onQueryChange' | 'onOpenChange'> {
  /** Query key for a search term, e.g. `(q) => queryKeys.users.hosts({ q })`. */
  queryKey: (query: string) => QueryKey
  /** Loads options for a (trimmed) search term, e.g. `(q, signal) => searchHosts({ q }, { signal })`. */
  fetchOptions: (query: string, signal: AbortSignal) => Promise<readonly T[]>
  /** Searches only run once the term has this many characters (0 = list on open). */
  minQueryLength?: number
  debounceMs?: number
}

/**
 * Combobox whose options come from the API (host and visitor pickers). Requests are
 * debounced, cancelled when superseded, cached by TanStack Query, and only made while
 * the popup is open.
 */
export function AsyncCombobox<T>({
  queryKey,
  fetchOptions,
  minQueryLength = 0,
  debounceMs = 250,
  ...comboboxProps
}: AsyncComboboxProps<T>) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const term = query.trim()
  const debouncedTerm = useDebouncedValue(term, debounceMs)
  const searchable = open && debouncedTerm.length >= minQueryLength

  const result = useQuery({
    queryKey: queryKey(debouncedTerm),
    queryFn: ({ signal }) => fetchOptions(debouncedTerm, signal),
    enabled: searchable,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })

  const tooShort = term.length < minQueryLength
  const waiting = !tooShort && (term !== debouncedTerm || result.isPending || result.isPlaceholderData)

  return (
    <Combobox
      {...comboboxProps}
      options={searchable && !tooShort ? (result.data ?? []) : []}
      loading={open && waiting && !result.isError}
      errorMessage={result.isError ? getErrorMessage(result.error) : null}
      idleMessage={tooShort ? t('combobox.typeAtLeast', { count: minQueryLength }) : null}
      onQueryChange={setQuery}
      onOpenChange={setOpen}
    />
  )
}

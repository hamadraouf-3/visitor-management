import { useId } from 'react'

/** A unique id safe for `id`, `htmlFor` and CSS selectors (React's useId may contain punctuation). */
export function useStableId(prefix: string, explicitId?: string): string {
  const generated = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  return explicitId ?? `${prefix}-${generated}`
}

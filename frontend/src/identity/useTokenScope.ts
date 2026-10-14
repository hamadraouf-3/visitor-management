import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * Colour tokens of their own for one element and what is inside it (Phase 12): the identity page's
 * preview draws a company's colours with the app's ordinary classes (`bg-accent`, `text-accent-text`)
 * while the page around it keeps the platform's. Each token of `tokens` (by its name without the
 * prefix: `accent`, `accent-text`) is set as `--color-<name>` on the element through the CSSOM,
 * which the style policy allows where a style attribute in markup is not. Null sets none: the
 * element then shows the colours it inherits.
 */
export function useTokenScope<Element extends HTMLElement>(tokens: Readonly<Record<string, string>> | null): RefObject<Element | null> {
  const ref = useRef<Element>(null)
  const signature = tokens ? JSON.stringify(tokens) : ''
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || signature === '') return
    const names = Object.entries(JSON.parse(signature) as Record<string, string>).map(([name, value]) => {
      const property = `--color-${name}`
      element.style.setProperty(property, value)
      return property
    })
    return () => {
      for (const property of names) element.style.removeProperty(property)
    }
  }, [signature])
  return ref
}

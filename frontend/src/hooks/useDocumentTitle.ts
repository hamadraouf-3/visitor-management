import { useEffect } from 'react'
import { useIdentityName } from '../identity/useIdentity'
import { getBaseTitle, setBaseTitle } from './documentTitle'

/**
 * Sets `document.title` while the component is mounted: "<title> · <company>" on a company's pages
 * (its name in the UI language), "<title> · Mawdoo3 Visitors" / "<title> · زوار موضوع" in the platform
 * owner's area, and the title alone on a neutral page (Phase 12). The name follows a language
 * switch and the identity. Pass the title in the UI language (`t(...)`). The shell may put a prefix
 * before it (Phase 16: "(2) " while tracking alerts are open, `documentTitle.ts`).
 */
export function useDocumentTitle(title: string | undefined): void {
  const name = useIdentityName()
  useEffect(() => {
    if (!title) return
    const previous = getBaseTitle()
    setBaseTitle(name ? `${title} · ${name}` : title)
    return () => {
      setBaseTitle(previous)
    }
  }, [title, name])
}

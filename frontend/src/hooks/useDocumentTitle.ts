import { useEffect } from 'react'
import { useIdentityName } from '../identity/useIdentity'

/**
 * Sets `document.title` while the component is mounted: "<title> · <company>" on a company's pages
 * (its name in the UI language), "<title> · Mawdoo3 Visitors" / "<title> · زوار موضوع" in the platform
 * owner's area, and the title alone on a neutral page (Phase 12). The name follows a language
 * switch and the identity. Pass the title in the UI language (`t(...)`).
 */
export function useDocumentTitle(title: string | undefined): void {
  const name = useIdentityName()
  useEffect(() => {
    if (!title) return
    const previous = document.title
    document.title = name ? `${title} · ${name}` : title
    return () => {
      document.title = previous
    }
  }, [title, name])
}

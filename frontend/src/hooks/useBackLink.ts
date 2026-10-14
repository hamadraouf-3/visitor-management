import { useLocation } from 'react-router'
import { useSessionUserId } from '../auth/useAuth'

/** Where a page's "Back to …" link leads. */
export interface BackLink {
  to: string
  /** Generic words ("Back to Visitors"): never a person's name, since it is kept in the browser's history. */
  label: string
  /** Router state for `to`: restores what the page there keeps out of its URL (its search text). */
  state?: unknown
  /** The user whose session wrote the link; set by `useBackLinkToHere`. */
  owner?: string | null
}

interface BackLinkState {
  backLink: BackLink
}

/**
 * Router `state` for a link to a detail page, so the detail page's back link returns to the
 * exact view the user came from (tab, search, page). The browser keeps the state of every
 * history entry after sign-out, so it is tagged with the user who wrote it.
 */
export function backLinkState(back: BackLink): BackLinkState {
  return { backLink: { to: back.to, label: back.label, state: back.state, owner: back.owner ?? null } }
}

/** Only in-app paths: never protocol-relative or absolute URLs. */
function isInAppPath(to: string): boolean {
  return to.startsWith('/') && !to.startsWith('//') && !to.includes('\\')
}

function isBackLink(value: unknown): value is BackLink {
  if (!value || typeof value !== 'object') return false
  const { to, label } = value as Partial<BackLink>
  return typeof to === 'string' && typeof label === 'string' && isInAppPath(to)
}

/**
 * The back link handed over by the previous page, else `fallback`. A link that another user's
 * session wrote into this tab's history (the tab was signed out and signed in again, then the
 * back button reached an older entry) is ignored.
 */
export function useBackLink(fallback: BackLink): BackLink {
  const { state } = useLocation()
  const owner = useSessionUserId()
  const candidate = state && typeof state === 'object' ? (state as Partial<BackLinkState>).backLink : undefined
  if (!isBackLink(candidate) || (candidate.owner ?? null) !== owner) return fallback
  return { to: candidate.to, label: candidate.label, state: candidate.state }
}

/** A back link to the current page as it is now: its address, and the state that restores its view. */
export function useBackLinkToHere(label: string): BackLink {
  const location = useLocation()
  const owner = useSessionUserId()
  return { to: `${location.pathname}${location.search}`, label, state: location.state ?? undefined, owner }
}

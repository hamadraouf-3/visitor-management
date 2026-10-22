import { matchPath } from 'react-router'
import type { NavEntry } from '../features/types'

/**
 * The navigation entry of the page shown: of the entries whose path matches the address (`end`: exactly;
 * otherwise it or a page under it), the most specific one. "Tracking alerts" (/journey/alerts) is under
 * "Visitor Journey" (/journey), whose own pages (/journey/{visit}) keep it current: only one entry is ever
 * the current page (Phase 16).
 */
export function currentEntry(entries: readonly NavEntry[], pathname: string): NavEntry | null {
  let best: NavEntry | null = null
  for (const entry of entries) {
    if (!matchPath({ path: entry.to, end: entry.end ?? false }, pathname)) continue
    if (!best || entry.to.length > best.to.length) best = entry
  }
  return best
}

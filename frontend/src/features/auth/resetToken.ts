/** Reset tokens are URL-safe random strings (`secrets.token_urlsafe`). */
const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/

export interface ResetTokenLoaderData {
  token: string | null
}

/**
 * Reads the reset token from the link fragment (`/reset-password#token=<raw>`, §7.2) and
 * removes it from the address bar with `history.replaceState` before the page renders, so it
 * is not on screen (or in a screenshot), not in this tab's back/forward entry, and not in the
 * DOM, storage or router state. Runs as the route loader.
 *
 * Limit: the browser already recorded the opened link, token included, in its saved history
 * (and address-bar suggestions) when it loaded the page; no page can remove that. The fragment
 * still keeps the token out of server and proxy logs and the Referer header, and the token is
 * single-use, expires after 30 minutes and is replaced by any newer reset request (§7.2). On a
 * shared device an abandoned reset link stays usable from that history until then, as from the
 * email itself; shared devices need the browser policy in phase-8-frontend.md (SEC-29).
 */
export function captureResetToken(): ResetTokenLoaderData {
  const { hash, pathname, search } = window.location
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash
  const token = new URLSearchParams(fragment).get('token')
  if (hash) {
    // Keep the router's history state so back/forward bookkeeping stays intact.
    window.history.replaceState(window.history.state, '', `${pathname}${search}`)
  }
  return { token: token && RESET_TOKEN_PATTERN.test(token) ? token : null }
}

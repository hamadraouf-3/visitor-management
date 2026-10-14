/**
 * Pass token parsing for scanner and handheld/paste input (§6). Pure. The backend parser
 * (`app.security.tokens.extract_pass_token`) applies the same grammar; both run the shared
 * cases in `docs/contract/pass-token-vectors.json`, which also states the rules in prose.
 * "Whitespace" there means exactly what `String.prototype.trim` removes; the backend strips
 * that same set (Python's own `str.strip()` would differ, e.g. on U+001D and U+FEFF).
 *
 * The grammar is a plain pattern rather than WHATWG URL parsing on purpose: URL parsing
 * normalises dot segments, backslashes and embedded tabs, which a server-side parser would
 * not reproduce, so the two sides could disagree on what a valid pass URL is.
 */
export const PASS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/

/**
 * `http(s)://<host[:port]>/pass[/][?query]#<token>`. Any origin, because the scanner may
 * read passes issued under another QR_BASE_URL (e.g. in development); no user info; the
 * scheme is case-insensitive, the path is not.
 */
const PASS_URL_PATTERN = /^[Hh][Tt][Tt][Pp][Ss]?:\/\/[^/?#@\\]+\/pass\/?(?:\?[^#]*)?#([A-Za-z0-9_-]{32,128})$/

export function isValidPassToken(value: string): boolean {
  return PASS_TOKEN_PATTERN.test(value)
}

/** Spaces and ASCII control characters never occur in a pass URL. */
function hasSpaceOrControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}

/** Returns the token, or null when the input is neither a valid token nor a pass URL. */
export function parsePassToken(input: string): string | null {
  const value = input.trim()
  if (isValidPassToken(value)) return value
  if (hasSpaceOrControl(value)) return null
  return PASS_URL_PATTERN.exec(value)?.[1] ?? null
}

/** Token from the `/pass` page's own location hash (`#<token>`), or null. */
export function passTokenFromHash(hash: string): string | null {
  const token = hash.startsWith('#') ? hash.slice(1) : hash
  return isValidPassToken(token) ? token : null
}

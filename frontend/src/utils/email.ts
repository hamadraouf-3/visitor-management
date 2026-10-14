/**
 * A `mailto:` link that opens a message to exactly this address.
 *
 * Visitor addresses are typed by staff and the server accepts every RFC 5322 `atext` character
 * in the local part, including `?`, `=` and `&`. Interpolated raw, `a?cc=x@evil.example` would
 * be read by mail clients as the recipient `a` plus a Cc header (RFC 6068 `hfields`), so a
 * click would address people chosen by whoever entered the visitor. Both parts are therefore
 * percent-encoded; the `@` separating them stays literal, which every client understands.
 */
export function mailtoHref(address: string): string {
  const at = address.lastIndexOf('@')
  if (at <= 0) return `mailto:${encodeURIComponent(address)}`
  return `mailto:${encodeURIComponent(address.slice(0, at))}@${encodeURIComponent(address.slice(at + 1))}`
}

/**
 * An address split where a line may break without hiding its structure: after the `@` and
 * before each dot of the domain. (`break-all` cut inside words, and breaking at a hyphen made
 * the hyphen read as part of the line end.) Joining the parts gives the address back.
 */
export function emailBreakParts(address: string): string[] {
  const at = address.lastIndexOf('@')
  if (at <= 0) return [address]
  const domainParts = address.slice(at + 1).split('.')
  return [address.slice(0, at + 1), ...domainParts.map((part, index) => (index === 0 ? part : `.${part}`))]
}

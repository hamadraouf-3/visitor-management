/*
 * The document's title, in two parts (Phase 16): the page's own title, which `useDocumentTitle` sets, and a
 * prefix the shell may put before it, "(2) " while tracking alerts are open. Each writer changes its part and
 * the title is written whole, so neither overwrites the other's. A title written to the document directly
 * (a test, the first page's HTML) becomes the page's own part.
 */

let base = ''
let prefix = ''

function adoptDocumentTitle(): void {
  const current = document.title
  if (current === `${prefix}${base}`) return
  base = prefix && current.startsWith(prefix) ? current.slice(prefix.length) : current
}

function render(): void {
  document.title = `${prefix}${base}`
}

/** The page's own title, without the prefix. */
export function getBaseTitle(): string {
  adoptDocumentTitle()
  return base
}

export function setBaseTitle(title: string): void {
  base = title
  render()
}

/** "(n) " before the page's title, or '' for none. */
export function setTitlePrefix(next: string): void {
  if (next === prefix) return
  adoptDocumentTitle()
  prefix = next
  render()
}

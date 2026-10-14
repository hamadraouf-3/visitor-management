/**
 * An object of texts read from the catalogs each time a property is read: `labels.today` is in
 * the UI language of that moment, so a module-level table of labels (statuses, tabs, methods)
 * keeps its shape and its call sites, and still follows a language switch on the next render
 * (F10-7). Each getter calls `t()` with a literal key, so keys stay type-checked.
 */
export function lazyTexts<T extends Record<string, () => string>>(getters: T): { readonly [K in keyof T]: string } {
  const texts = {} as { [K in keyof T]: string }
  for (const [key, read] of Object.entries(getters)) {
    Object.defineProperty(texts, key, { get: read, enumerable: true })
  }
  return texts
}

import { i18n } from './index'
import type { Namespace } from './resources'

/** `t` without the key types: only for keys built from data (`catalogText`). */
const untypedT = i18n.t.bind(i18n) as unknown as (key: string, options: Record<string, unknown>) => string

/**
 * The catalog's text for a key that is only known at run time, such as an enum code the API
 * sends (an audit action, a metadata value), or null when the catalog has no such key, so the
 * caller can fall back (a code from a newer server still reads sensibly). Keys written in the
 * source use the type-checked `t()` instead.
 */
export function catalogText(namespace: Namespace, key: string, options: Record<string, unknown> = {}): string | null {
  // The options go to the lookup too: a counted key exists only as its plural forms (`maxLength_one`).
  if (!i18n.exists(key, { ns: namespace, ...options })) return null
  return untypedT(key, { ns: namespace, ...options })
}

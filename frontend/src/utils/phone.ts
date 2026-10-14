/**
 * Phone numbers are shown as stored and dialled as their digits, so the two must never differ
 * (the server's `Phone` grammar, SEC-10).
 *
 * The server accepts decimal digits of three scripts: ASCII, Arabic-Indic (U+0660–U+0669) and
 * Extended Arabic-Indic (U+06F0–U+06F9), the digits of Arabic and Persian keyboards. JavaScript's
 * `\d` matches ASCII digits only, so they are mapped to ASCII before anything is dialled.
 */
const DIGIT = '0-9\u0660-\u0669\u06F0-\u06F9'
/** Space, no-break space, narrow no-break space, ( ) . / - */
const SEPARATOR = ' \u00A0\u202F().\\/\\-'

/**
 * The server's phone grammar (`backend/app/schemas/common.py`, `_PHONE`): an optional leading
 * "+", at least three digits with separators, and optionally an extension ("x 12", "ext. 12").
 * Group 1 is the number without its extension.
 */
const PHONE = new RegExp(`^(\\+?[${SEPARATOR}]*(?:[${DIGIT}][${SEPARATOR}]*){3,})(?:(?:x|ext\\.?)[${SEPARATOR}]*[${DIGIT}]{1,6})?$`, 'i')

const NON_ASCII_DIGIT = /[\u0660-\u0669\u06F0-\u06F9]/g

/** `text` with its Arabic-Indic and Extended Arabic-Indic digits as ASCII digits ("٠٧٩" → "079"). */
export function asciiDigits(text: string): string {
  return text.replace(NON_ASCII_DIGIT, (digit) => {
    const code = digit.charCodeAt(0)
    return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660))
  })
}

/**
 * The `tel:` URI of a phone number as stored ("+962 79 500 1002" → "tel:+962795001002"), or null
 * when the text cannot be dialled as shown. The dialler gets one unbroken number: the digits in
 * stored order, Arabic-Indic ones as ASCII, and a leading plus.
 *
 * - Only text that follows the server's grammar is dialled. Older rows (stored before SEC-10)
 *   may hold words, a second number or direction controls, whose digits run together would be
 *   another number than the one shown; they stay plain text.
 * - An extension is shown, not dialled: appended, its digits would make a longer, wrong number,
 *   and the `;ext=` and pause notations are handled differently by each dialler (some strip them
 *   to the same wrong number). The call reaches the main number.
 */
export function telHref(phone: string): string | null {
  const match = PHONE.exec(phone)
  if (!match) return null
  const number = asciiDigits(match[1] ?? '').replace(/[^\d+]/g, '')
  return `tel:${number}`
}

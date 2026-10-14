import { currentLanguage, i18n, type Language } from '../i18n'

/**
 * Items of a list in one line of text, with the language's separator: "Previous day, Overdue",
 * «من يوم سابق، تجاوز وقت المغادرة».
 */
export function joinList(items: readonly string[], language: Language = currentLanguage()): string {
  return items.join(i18n.t('text.listSeparator', { lng: language }))
}

/** The separator between items of data in one line ("Host Omar Khalil · Operations"; `DataLine`). */
export const DATA_SEPARATOR = ' · '

/** "120 of 500 characters": a counter for limited text fields (in the field's hint). */
export function characterCountLabel(value: string, max: number, language: Language = currentLanguage()): string {
  return i18n.t('text.characterCount', { lng: language, count: max, length: value.length })
}

/**
 * A sentence that names an email address. The address is kept apart so the UI can render it
 * with break opportunities at its separators (EmailText) instead of breaking mid-word.
 */
export type TextPart = string | { email: string }

/** The sentence as plain text (tests, titles, toasts). */
export function plainText(parts: readonly TextPart[]): string {
  return parts.map((part) => (typeof part === 'string' ? part : part.email)).join('')
}

/** Brackets a placeholder's name while a catalog sentence is split (an invisible separator, never typed). */
const PART_MARK = '\u2063'
const PART_PATTERN = /\u2063(\w+)\u2063/

/**
 * A catalog sentence whose placeholders are parts of their own (an e-mail address, kept apart for
 * `TextWithEmails`): `translate` receives a marker for each placeholder and returns the sentence
 * in the UI language; the result is split around the markers, so each language puts the address
 * where its grammar wants it ("Invitation sent to x." / «أُرسلت الدعوة إلى x.»).
 */
export function textWithParts<P extends Record<string, TextPart>>(translate: (markers: { [K in keyof P]: string }) => string, parts: P): TextPart[] {
  const markers = Object.fromEntries(Object.keys(parts).map((name) => [name, `${PART_MARK}${name}${PART_MARK}`])) as { [K in keyof P]: string }
  return translate(markers)
    .split(PART_PATTERN)
    .map((piece, index) => (index % 2 === 1 ? (parts[piece] ?? piece) : piece))
    .filter((piece) => piece !== '')
}

const ARABIC_LETTER = /\p{Script=Arabic}/u

/** The Arabic definite article at the start of a name part ("الحسن"): the initial is the letter after it. */
const ARABIC_ARTICLE = /^\u0627\u0644(?=\p{Script=Arabic})/u

/** Zero-width non-joiner: keeps two Arabic initials as separate letters instead of a joined word. */
const ZWNJ = '\u200c'

/** The first letter of a name part, after the Arabic article if it has one. */
function initialOf(part: string | undefined): string {
  return part ? ([...part.replace(ARABIC_ARTICLE, '')][0] ?? '') : ''
}

/**
 * The one letter that stands for a name on a small tile (a company's app icon): the first letter or
 * digit of its first word, after the Arabic article («البنك العربي» → «ب», "Sahara Sun" → "S"). In
 * the name's own script; empty when the name has neither a letter nor a digit.
 */
export function leadingLetter(name: string): string {
  for (const part of name.trim().split(/\s+/)) {
    const letter = [...part.replace(ARABIC_ARTICLE, '')].find((character) => /[\p{L}\p{N}]/u.test(character))
    if (letter) return letter.toUpperCase()
  }
  return ''
}

/**
 * Up to two initials for an avatar: "Lina Haddad" → "LH", "Omar" → "O".
 *
 * Arabic letters join into words, and surnames often start with the article «ال»: plain
 * concatenation turned «ليلى الحسن» into «لا» (the word "no") and «أحمد الخطيب» into «أا». For a
 * name in Arabic script the article is skipped («الحسن» → «ح») and a zero-width non-joiner keeps
 * the two letters apart (each letter in its own form, as in direction C's avatars).
 */
export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  const first = initialOf(parts[0])
  const last = parts.length > 1 ? initialOf(parts[parts.length - 1]) : ''
  const separator = first && last && (ARABIC_LETTER.test(first) || ARABIC_LETTER.test(last)) ? ZWNJ : ''
  return `${first}${separator}${last}`.toUpperCase() || '?'
}

/**
 * Whether a required text has nothing to read: only white space and characters that render as
 * nothing (Unicode's Default_Ignorable_Code_Point set: U+200B zero-width space, U+2060 word
 * joiner, U+FEFF, the bidirectional marks, the Hangul fillers such as U+3164, …, plus U+2800, the
 * blank braille cell), most of which `String.prototype.trim()` keeps. The server refuses such a
 * value as empty (phase 8 backend, L-BE-1, the same set); the forms say so first, in their own
 * words. Text with anything visible is never blank, joiners inside a word included.
 */
export function isBlankText(text: string): boolean {
  return text.replace(/[\s\p{Default_Ignorable_Code_Point}\u2800]/gu, '') === ''
}

/** Lowercase without accents ("É" → "e"), for matching what people type against names and other text. */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

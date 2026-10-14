import { Fragment, type ReactNode } from 'react'

/** Brackets a placeholder's name while a catalog sentence is split (U+2063, an invisible separator, never typed). */
const MARK = String.fromCharCode(0x2063)
const PART_PATTERN = new RegExp(`${MARK}(\\w+)${MARK}`)

/**
 * A catalog sentence whose placeholders are elements of their own (a count kept on one line with
 * its word, a link): `translate` receives a marker for each placeholder and returns the sentence
 * in the UI language, which is split around the markers. Each language then puts the parts where
 * its grammar wants them, and joins words as its script does (Arabic «و» is written against the
 * next word: "منها {{cancelled}} و{{walkIns}}"), which gluing English words around elements cannot.
 */
export function withParts<P extends Record<string, ReactNode>>(translate: (markers: { [K in keyof P]: string }) => string, parts: P): ReactNode[] {
  const markers = Object.fromEntries(Object.keys(parts).map((name) => [name, `${MARK}${name}${MARK}`])) as { [K in keyof P]: string }
  return translate(markers)
    .split(PART_PATTERN)
    .map((piece, index) => (index % 2 === 1 ? <Fragment key={index}>{parts[piece]}</Fragment> : piece))
    .filter((piece) => piece !== '')
}

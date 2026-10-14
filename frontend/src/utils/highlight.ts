import { foldText } from './text'

/**
 * Where `query` occurs in `text`, ignoring case and accents: `[start, end)` in `text`, or null.
 * Used to show why a search result matched (the server matches more loosely, e.g. Arabic
 * letter variants or phone digits; such matches are simply not highlighted).
 */
export function findMatch(text: string, query: string): [number, number] | null {
  const needle = [...query.trim()].map(foldText).join('')
  if (!needle) return null
  // Folded one character at a time, so every folded position maps back to the text.
  let folded = ''
  // folded index → index in `text` of the character it came from
  const origin: number[] = []
  let index = 0
  for (const character of text) {
    const part = foldText(character)
    for (let i = 0; i < part.length; i += 1) origin.push(index)
    folded += part
    index += character.length
  }
  const at = folded.indexOf(needle)
  if (at === -1) return null
  const start = origin[at]!
  const lastOrigin = origin[at + needle.length - 1]!
  const lastCharacter = String.fromCodePoint(text.codePointAt(lastOrigin)!)
  return [start, lastOrigin + lastCharacter.length]
}

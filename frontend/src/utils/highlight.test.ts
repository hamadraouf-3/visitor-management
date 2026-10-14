import { describe, expect, it } from 'vitest'
import { findMatch } from './highlight'

function marked(text: string, query: string): string {
  const match = findMatch(text, query)
  return match ? `${text.slice(0, match[0])}[${text.slice(match[0], match[1])}]${text.slice(match[1])}` : text
}

describe('findMatch', () => {
  it('finds the query ignoring case', () => {
    expect(marked('Economy Partners', 'om')).toBe('Econ[om]y Partners')
    expect(marked('Omar Khalil', 'OM')).toBe('[Om]ar Khalil')
  })

  it('ignores accents in either text and keeps the original characters', () => {
    expect(marked('Élodie Martin', 'elo')).toBe('[Élo]die Martin')
    expect(marked('Elodie Martin', 'élo')).toBe('[Elo]die Martin')
  })

  it('maps positions back through characters outside the BMP', () => {
    expect(marked('😀 Ana', 'ana')).toBe('😀 [Ana]')
  })

  it('returns null without a match or a query', () => {
    expect(findMatch('Layla Haddad', 'zz')).toBeNull()
    expect(findMatch('Layla Haddad', '  ')).toBeNull()
  })
})

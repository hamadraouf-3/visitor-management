import { describe, expect, it } from 'vitest'
import { isValidPassToken, parsePassToken, passTokenFromHash } from './parsePassToken'
import vectors from '../../../docs/contract/pass-token-vectors.json'

// secrets.token_urlsafe(32) produces 43 URL-safe characters.
const TOKEN = 'Xo3_vK9-aQ2rT7mN4bL8cY1zW6eH5jP0sD-gF_uIk2A'

describe('parsePassToken: shared vectors (the backend parser runs the same table)', () => {
  it('covers both accepted and rejected inputs', () => {
    expect(vectors.cases.filter((vector) => vector.expected !== null).length).toBeGreaterThan(5)
    expect(vectors.cases.filter((vector) => vector.expected === null).length).toBeGreaterThan(20)
    expect(new Set(vectors.cases.map((vector) => vector.name)).size).toBe(vectors.cases.length)
  })

  it.each(vectors.cases)('$name', ({ input, expected }) => {
    expect(parsePassToken(input)).toBe(expected)
  })
})

describe('parsePassToken: properties', () => {
  it('only ever returns null or a well-formed token', () => {
    const tokens = vectors.cases.map(({ input }) => parsePassToken(input)).filter((token) => token !== null)
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens.filter((token) => !isValidPassToken(token))).toEqual([])
  })

  it('trims exactly the ECMAScript whitespace set that the backend parser mirrors', () => {
    // Trimmed: the BOM, Unicode spaces and line terminators (escaped: they are invisible in source).
    expect(parsePassToken(`\uFEFF${TOKEN}\u00A0`)).toBe(TOKEN)
    expect(parsePassToken(`\u3000${TOKEN}\u2028`)).toBe(TOKEN)
    // Not trimmed (Python's str.strip() would remove them): information separators and NEL.
    expect(parsePassToken(`${TOKEN}\u001D`)).toBeNull()
    expect(parsePassToken(`${TOKEN}\u001E`)).toBeNull()
    expect(parsePassToken(`${TOKEN}\u0085`)).toBeNull()
  })

  it('extracts exactly the token issued in a pass URL, whatever the origin', () => {
    for (const origin of ['https://visitors.example.com', 'http://localhost:4173', 'https://10.0.0.5:8443']) {
      expect(parsePassToken(`${origin}/pass#${TOKEN}`)).toBe(TOKEN)
    }
  })

  it('reads both forms of a pass link: with its company (Phase 12) and the older one without', () => {
    for (const origin of ['https://visitors.example.com', 'http://localhost:4173']) {
      // What the backend writes since Phase 12: the company's slug in the query, the token in the fragment.
      expect(parsePassToken(`${origin}/pass?c=nova-labs#${TOKEN}`)).toBe(TOKEN)
      expect(parsePassToken(`${origin}/pass?c=a#${TOKEN}`)).toBe(TOKEN)
      expect(parsePassToken(`  ${origin}/pass?c=other-corp#${TOKEN}\n`)).toBe(TOKEN)
      // Links issued before it keep working.
      expect(parsePassToken(`${origin}/pass#${TOKEN}`)).toBe(TOKEN)
    }
  })

  it('never takes a token from anywhere but the fragment, with or without a company', () => {
    const origin = 'https://visitors.example.com'
    expect(parsePassToken(`${origin}/pass?c=nova-labs&token=${TOKEN}`)).toBeNull()
    expect(parsePassToken(`${origin}/pass?c=${TOKEN}`)).toBeNull()
    expect(parsePassToken(`${origin}/pass?c=nova-labs#token=${TOKEN}`)).toBeNull()
    expect(parsePassToken(`${origin}/pass?c=nova-labs`)).toBeNull()
    expect(parsePassToken(`${origin}/c/nova-labs#${TOKEN}`)).toBeNull()
    // The company is no part of what is read: another slug, the same token.
    expect(parsePassToken(`${origin}/pass?c=another-company#${TOKEN}`)).toBe(TOKEN)
  })
})

describe('passTokenFromHash', () => {
  it('reads the token from the /pass page fragment', () => {
    expect(passTokenFromHash(`#${TOKEN}`)).toBe(TOKEN)
    expect(passTokenFromHash(TOKEN)).toBe(TOKEN)
  })

  it('rejects missing or malformed fragments', () => {
    expect(passTokenFromHash('')).toBeNull()
    expect(passTokenFromHash('#')).toBeNull()
    expect(passTokenFromHash(`#token=${TOKEN}`)).toBeNull()
    expect(passTokenFromHash('#abc')).toBeNull()
  })

  it('agrees with isValidPassToken', () => {
    expect(isValidPassToken(TOKEN)).toBe(true)
    expect(isValidPassToken(`#${TOKEN}`)).toBe(false)
  })
})

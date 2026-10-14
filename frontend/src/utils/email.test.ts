import { describe, expect, it } from 'vitest'
import { emailBreakParts, mailtoHref } from './email'

describe('mailtoHref', () => {
  it('keeps an ordinary address readable', () => {
    expect(mailtoHref('elodie@orbit.example')).toBe('mailto:elodie@orbit.example')
  })

  it('cannot be turned into extra headers by characters the server accepts in the local part', () => {
    const href = mailtoHref('a?cc=evil@example.com')
    expect(href).toBe('mailto:a%3Fcc%3Devil@example.com')
    // Parsed as a URL there is no query, so no Cc/Bcc/Body header reaches the mail client.
    expect(new URL(href).search).toBe('')
    expect(mailtoHref('x&body=hi@example.com')).toBe('mailto:x%26body%3Dhi@example.com')
  })

  it('splits at the last @ (a quoted local part may contain another one)', () => {
    expect(mailtoHref('"a@b"@example.com')).toBe('mailto:%22a%40b%22@example.com')
  })
})

describe('emailBreakParts', () => {
  it('allows breaks after the @ and before each dot of the domain', () => {
    expect(emailBreakParts('d.okafor@okafor-logistics.example')).toEqual(['d.okafor@', 'okafor-logistics', '.example'])
    expect(emailBreakParts('d.okafor@okafor-logistics.example').join('')).toBe('d.okafor@okafor-logistics.example')
  })

  it('leaves text without an @ whole', () => {
    expect(emailBreakParts('not-an-address')).toEqual(['not-an-address'])
  })
})

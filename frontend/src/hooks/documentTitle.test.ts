import { afterEach, describe, expect, it } from 'vitest'
import { getBaseTitle, setBaseTitle, setTitlePrefix } from './documentTitle'

afterEach(() => {
  setTitlePrefix('')
  document.title = ''
})

describe('the document’s title in two parts (Phase 16)', () => {
  it('puts the prefix before the page’s title, whichever is set first, and takes it away', () => {
    setBaseTitle('Reception · Acme')
    setTitlePrefix('(2) ')
    expect(document.title).toBe('(2) Reception · Acme')
    setBaseTitle('Visitor Journey · Acme')
    expect(document.title).toBe('(2) Visitor Journey · Acme')
    expect(getBaseTitle()).toBe('Visitor Journey · Acme')
    setTitlePrefix('')
    expect(document.title).toBe('Visitor Journey · Acme')
  })

  it('takes a title written to the document directly as the page’s own', () => {
    document.title = 'Sign in'
    setTitlePrefix('(1) ')
    expect(document.title).toBe('(1) Sign in')
    expect(getBaseTitle()).toBe('Sign in')
  })
})

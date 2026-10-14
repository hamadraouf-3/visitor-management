import { describe, expect, it } from 'vitest'

/** MutationObserver callbacks run as microtasks after the attribute change. */
const flushObservers = () => Promise.resolve()

// The emulation lives in src/test/setup.ts (jsdom does not apply the focus fixup rule).
describe('test environment: focus fixup', () => {
  it('moves focus to the document when the focused button becomes disabled', async () => {
    document.body.innerHTML = '<button type="button">Save</button>'
    const button = document.querySelector('button')!
    button.focus()

    button.disabled = true
    await flushObservers()

    expect(document.activeElement).toBe(document.body)
  })

  it('also when a fieldset around the focused control becomes disabled', async () => {
    document.body.innerHTML = '<fieldset><input aria-label="Name" /></fieldset>'
    const input = document.querySelector('input')!
    input.focus()

    document.querySelector('fieldset')!.disabled = true
    await flushObservers()

    expect(document.activeElement).toBe(document.body)
  })

  it('leaves focus alone for aria-disabled and for other elements becoming disabled', async () => {
    document.body.innerHTML = '<button type="button">Next</button><button type="button">Previous</button>'
    const [next, previous] = document.querySelectorAll('button')
    next!.focus()

    next!.setAttribute('aria-disabled', 'true')
    previous!.disabled = true
    await flushObservers()

    expect(document.activeElement).toBe(next)
  })
})

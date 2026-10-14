import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { STICKY_ACTIONS_HEIGHT, StickyActionBar } from './StickyActionBar'

/** A ResizeObserver whose callbacks the test fires; records what it observes. */
function stubResizeObserver() {
  const observers: { callback: () => void; targets: { target: Element; options?: ResizeObserverOptions }[] }[] = []
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly entry: (typeof observers)[number]
      constructor(callback: () => void) {
        this.entry = { callback, targets: [] }
        observers.push(this.entry)
      }
      observe(target: Element, options?: ResizeObserverOptions) {
        this.entry.targets.push({ target, options })
      }
      unobserve() {}
      disconnect() {
        this.entry.targets.length = 0
      }
    },
  )
  return { resize: () => act(() => observers.forEach((observer) => observer.targets.length > 0 && observer.callback())), observers }
}

/** Every element reports `height` as its border-box height. */
function stubHeight(height: () => number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 390, height()))
}

const published = () => document.documentElement.style.getPropertyValue(STICKY_ACTIONS_HEIGHT)

/** The frame after the browser's own scroll-into-view of the focused element. */
const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))

describe('StickyActionBar', () => {
  it('publishes its height for the page’s scroll padding, follows its size and withdraws it when gone', () => {
    const { resize, observers } = stubResizeObserver()
    let height = 156.5
    stubHeight(() => height)

    const view = render(
      <form>
        <StickyActionBar className="flex flex-col">
          <button type="submit">Save changes</button>
        </StickyActionBar>
      </form>,
    )
    const bar = view.container.querySelector('[data-sticky-actions]')

    // The stacked phone layout: status line and two full-width buttons (whole pixels, rounded up).
    expect(published()).toBe('157px')
    // The border box, so a change of the safe-area padding counts too.
    expect(observers[0]?.targets).toEqual([{ target: bar, options: { box: 'border-box' } }])

    height = 70
    resize()
    expect(published()).toBe('70px')

    view.unmount()
    expect(published()).toBe('')
  })

  it('publishes the tallest while two bars are on screen, and the remaining one after the other leaves', () => {
    stubResizeObserver()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return new DOMRect(0, 0, 390, this.classList.contains('tall') ? 157 : 70)
    })

    const tall = render(
      <StickyActionBar className="tall">
        <button type="submit">Save changes</button>
      </StickyActionBar>,
    )
    const short = render(
      <StickyActionBar className="short">
        <button type="submit">Check in walk-in</button>
      </StickyActionBar>,
    )
    expect(published()).toBe('157px')

    tall.unmount()
    expect(published()).toBe('70px')
    short.unmount()
    expect(published()).toBe('')
  })

  it('still publishes its height once where ResizeObserver is missing', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    stubHeight(() => 120)

    const view = render(
      <StickyActionBar>
        <button type="button">Check in walk-in</button>
      </StickyActionBar>,
    )

    expect(published()).toBe('120px')
    view.unmount()
    expect(published()).toBe('')
  })
})

describe('StickyActionBar: a focused field is revealed above it', () => {
  /*
   * The company settings on a 320 × 720 phone: the stacked bar covers 563–720. The browser
   * scrolled the "Address" text area only as far as its caret line, to 516–606.
   */
  const BAR = new DOMRect(0, 563, 320, 157)
  const boxes: Record<string, DOMRect> = {
    address: new DOMRect(16, 516, 288, 90),
    name: new DOMRect(16, 380, 288, 40),
    // Its focus ring (4 px) would reach 2 px under the bar.
    domain: new DOMRect(16, 521, 288, 40),
    // A whole tab panel, taller than the screen.
    panel: new DOMRect(0, 98, 320, 1387),
    // A segmented choice: the visually hidden radio (1 px) is in view, the segment that draws its
    // ring reaches 10 px under the bar.
    'segment-radio': new DOMRect(16, 517, 1, 1),
    segment: new DOMRect(16, 517, 140, 56),
  }

  function renderForm() {
    stubResizeObserver()
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.matches('[data-sticky-actions]')) return BAR
      return boxes[this.id] ?? new DOMRect()
    })
    const view = render(
      <form>
        <input id="name" aria-label="Company name" />
        <input id="domain" aria-label="Email domain" />
        <label htmlFor="address">Address</label>
        <textarea id="address" />
        <div id="panel" role="tabpanel" tabIndex={0} aria-label="Walk-in" />
        <label id="segment">
          <input id="segment-radio" type="radio" name="reason" className="sr-only" />
          No invitation
        </label>
        <StickyActionBar>
          <button type="button">Save changes</button>
        </StickyActionBar>
      </form>,
    )
    const bar = view.container.querySelector<HTMLElement>('[data-sticky-actions]')!
    // What is on top at a point: the bar where it is, unless a test puts something above it.
    let onTop: (y: number) => Element | null = (y) => (y >= BAR.top ? bar : null)
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: (_x: number, y: number) => onTop(y) })
    const scrolled = vi.fn<(element: HTMLElement, options: ScrollIntoViewOptions | boolean | undefined) => void>()
    for (const element of view.container.querySelectorAll<HTMLElement>('input, textarea, button, label, [tabindex]')) {
      element.scrollIntoView = (options) => scrolled(element, options)
    }
    return { view, scrolled, coverWith: (element: Element) => (onTop = () => element) }
  }

  afterEach(() => {
    Reflect.deleteProperty(document, 'elementFromPoint')
  })

  it('scrolls a text area that the browser left partly under the bar fully above it, on Tab and on focus after a click', async () => {
    const user = userEvent.setup()
    const { scrolled } = renderForm()
    const address = screen.getByLabelText('Address')
    const callsFor = (element: HTMLElement) => scrolled.mock.calls.filter(([target]) => target === element).map(([, options]) => options)

    await user.tab()
    await user.tab()
    await user.tab()
    expect(address).toHaveFocus()
    await nextFrame()
    // `nearest` honours the page's scroll padding: the bar's height plus room for the ring.
    expect(callsFor(address)).toEqual([{ block: 'nearest', inline: 'nearest' }])

    // Focus on the first invalid field after a click on Save is not a click on the field.
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    act(() => address.focus())
    await nextFrame()
    expect(callsFor(address)).toHaveLength(2)
  })

  it('reveals the segment that shows a visually hidden radio’s focus', async () => {
    const { scrolled } = renderForm()

    act(() => screen.getByRole('radio', { name: 'No invitation' }).focus())
    await nextFrame()

    expect(scrolled.mock.calls).toEqual([[document.getElementById('segment'), { block: 'nearest', inline: 'nearest' }]])
  })

  it('counts the focus ring as part of the control', async () => {
    const { scrolled } = renderForm()
    const domain = screen.getByRole('textbox', { name: 'Email domain' })

    act(() => domain.focus())
    await nextFrame()

    expect(scrolled.mock.calls).toEqual([[domain, { block: 'nearest', inline: 'nearest' }]])
  })

  it('leaves alone a control clear of the bar, one inside it, one taller than the screen, and one under a dialog', async () => {
    const { scrolled, coverWith } = renderForm()

    act(() => screen.getByRole('textbox', { name: 'Company name' }).focus())
    await nextFrame()
    act(() => screen.getByRole('button', { name: 'Save changes' }).focus())
    await nextFrame()
    act(() => screen.getByRole('tabpanel').focus())
    await nextFrame()
    expect(scrolled).not.toHaveBeenCalled()

    const dialog = document.createElement('div')
    document.body.append(dialog)
    coverWith(dialog)
    act(() => screen.getByLabelText('Address').focus())
    await nextFrame()
    expect(scrolled).not.toHaveBeenCalled()
  })

  it('does not scroll the page under a click or tap on the field or its label, but does on the next keyboard focus', async () => {
    const user = userEvent.setup()
    const { scrolled } = renderForm()
    const address = screen.getByLabelText('Address')

    await user.click(address)
    expect(address).toHaveFocus()
    await nextFrame()
    await user.click(screen.getByRole('textbox', { name: 'Email domain' }))
    await user.click(screen.getByText('Address'))
    expect(address).toHaveFocus()
    await nextFrame()
    // The click on "Email domain" was a pointer focus too.
    expect(scrolled).not.toHaveBeenCalled()

    await user.tab({ shift: true })
    await user.tab()
    await nextFrame()
    expect(scrolled.mock.calls.filter(([element]) => element === address)).toHaveLength(1)
  })

  it('watches focus once while any bar is on screen and stops with the last one', async () => {
    const added = vi.spyOn(document, 'addEventListener')
    const removed = vi.spyOn(document, 'removeEventListener')
    // React adds a listener of its own to the document on its first render.
    const types = (spy: typeof added) =>
      spy.mock.calls.map(([type]) => type).filter((type) => ['focusin', 'keydown', 'pointerdown'].includes(type)).toSorted()
    const { view, scrolled } = renderForm()
    const second = render(
      <StickyActionBar>
        <button type="button">Check in walk-in</button>
      </StickyActionBar>,
    )
    expect(types(added)).toEqual(['focusin', 'keydown', 'pointerdown'])

    second.unmount()
    expect(types(removed)).toEqual([])
    act(() => screen.getByLabelText('Address').focus())
    // Unmounted before the frame: the pending check is dropped too.
    view.unmount()
    expect(types(removed)).toEqual(['focusin', 'keydown', 'pointerdown'])
    await nextFrame()
    expect(scrolled).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerServiceWorker, shouldRegisterServiceWorker } from './registerServiceWorker'

describe('shouldRegisterServiceWorker', () => {
  it.each(['/pass', '/pass/', '/PASS'])('skips the visitor pass page (%s), as the router matches it', (pathname) => {
    expect(shouldRegisterServiceWorker(pathname)).toBe(false)
  })

  it.each(['/', '/login', '/reception', '/visits/new', '/passes'])('registers on %s', (pathname) => {
    expect(shouldRegisterServiceWorker(pathname)).toBe(true)
  })
})

describe('registerServiceWorker', () => {
  const register = vi.fn<(url: string, options: RegistrationOptions) => Promise<unknown>>()
  let onLoad: (() => void) | undefined

  beforeEach(() => {
    register.mockReset().mockResolvedValue({})
    onLoad = undefined
    vi.stubEnv('PROD', true)
    Object.defineProperty(navigator, 'serviceWorker', { value: { register }, configurable: true })
    vi.spyOn(window, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'load' && typeof listener === 'function') onLoad = () => listener(new Event('load'))
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker')
  })

  it('registers the worker for the whole app once the page has loaded', () => {
    window.history.replaceState(null, '', '/login')
    registerServiceWorker()
    expect(register).not.toHaveBeenCalled()

    onLoad?.()
    expect(register).toHaveBeenCalledExactlyOnceWith('/sw.js', { scope: '/', updateViaCache: 'none' })
  })

  it('does not install the staff app on a visitor’s phone that opens a pass', () => {
    window.history.replaceState(null, '', '/pass#v1.c2VjcmV0')
    registerServiceWorker()
    onLoad?.()

    expect(onLoad).toBeUndefined()
    expect(register).not.toHaveBeenCalled()
  })

  it('does nothing in development, where a worker would fight hot reloading', () => {
    vi.stubEnv('PROD', false)
    window.history.replaceState(null, '', '/login')
    registerServiceWorker()
    onLoad?.()

    expect(register).not.toHaveBeenCalled()
  })
})

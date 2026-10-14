import { test as base, expect, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test'
import { platformStorageStatePath, storageStatePath, type AccountKey } from './accounts.ts'
import { Api } from './api.ts'
import { BASE_URL } from './paths.ts'

/** The three viewports of contract §11. Tablet and phone emulate touch (`pointer: coarse`). */
export const DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, hasTouch: false },
  tablet: { viewport: { width: 820, height: 1180 }, hasTouch: true },
  mobile: { viewport: { width: 390, height: 844 }, hasTouch: true },
} as const satisfies Record<string, Pick<BrowserContextOptions, 'viewport' | 'hasTouch'>>

export type DeviceName = keyof typeof DEVICES

export interface OpenOptions {
  /** A seeded account's signed-in state; omitted for a browser that is not signed in. */
  as?: AccountKey
  /** The platform owner's signed-in state (Phase 11) instead of a company account's. */
  platform?: boolean
  /** Default: the project's own viewport (desktop, tablet, mobile), desktop for the `flows` project. */
  device?: DeviceName
  /** Extra context options (permissions, …). */
  options?: BrowserContextOptions
}

export interface Session {
  context: BrowserContext
  page: Page
  api: Api
}

interface Fixtures {
  /** The JSON API as a seeded account (disposed after the test). */
  apiAs: (account: AccountKey) => Promise<Api>
  /**
   * A new browser context with its own page, e.g. one per person in a scenario. Contexts made
   * with `browser.newContext()` do not inherit the project's `use` options, so the base URL and
   * the browser's time zone are set here.
   */
  open: (options?: OpenOptions) => Promise<Session>
}

export function contextOptions(browserTimeZone: string | undefined, { as, platform = false, device = 'desktop', options }: OpenOptions = {}): BrowserContextOptions {
  return {
    baseURL: BASE_URL,
    // An English browser: a context without a stored language (signed out) shows the English UI (F10-12).
    locale: 'en-US',
    ...DEVICES[device],
    ...(browserTimeZone ? { timezoneId: browserTimeZone } : {}),
    ...(as ? { storageState: storageStatePath(as) } : {}),
    ...(platform ? { storageState: platformStorageStatePath() } : {}),
    ...options,
  }
}

export async function openSession(browser: Browser, browserTimeZone: string | undefined, options: OpenOptions = {}): Promise<Session> {
  const context = await browser.newContext(contextOptions(browserTimeZone, options))
  const page = await context.newPage()
  return { context, page, api: Api.of(context) }
}

export const test = base.extend<Fixtures>({
  apiAs: async ({ baseURL }, provide) => {
    const created: Api[] = []
    await provide(async (account) => {
      const api = await Api.as(account, baseURL)
      created.push(api)
      return api
    })
    await Promise.all(created.map((api) => api.dispose()))
  },
  open: async ({ browser, timezoneId }, provide, testInfo) => {
    const contexts: BrowserContext[] = []
    const projectDevice: DeviceName = testInfo.project.name in DEVICES ? (testInfo.project.name as DeviceName) : 'desktop'
    await provide(async (options = {}) => {
      const session = await openSession(browser, timezoneId, { device: projectDevice, ...options })
      contexts.push(session.context)
      return session
    })
    await Promise.all(contexts.map((context) => context.close()))
  },
})

export { expect }

// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import type { PrecacheManifest } from './serviceWorkerPrecache.ts'

/*
 * Runs the real `public/sw.js` against an in-memory Cache Storage and network, and checks what
 * an install downloads (§10 PWA). Content-hashed files must come from an older cache or the HTTP
 * cache; only files whose URL does not change with their content bypass the HTTP cache.
 */

const WORKER_SOURCE = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8')
const ORIGIN = 'https://vms.example'

const pathOf = (input: string | Request) => new URL(typeof input === 'string' ? input : input.url, ORIGIN).pathname

class FakeCache {
  readonly entries = new Map<string, { body: string; headers: [string, string][] }>()
  private readonly network: FakeNetwork

  constructor(network: FakeNetwork) {
    this.network = network
  }

  match(input: string | Request): Promise<Response | undefined> {
    const entry = this.entries.get(pathOf(input))
    return Promise.resolve(entry ? new Response(entry.body, { headers: entry.headers }) : undefined)
  }

  async put(input: string | Request, response: Response): Promise<void> {
    this.entries.set(pathOf(input), { body: await response.text(), headers: [...response.headers] })
  }

  async add(request: Request): Promise<void> {
    await this.addAll([request])
  }

  /** All or nothing, as in a browser. */
  async addAll(requests: Request[]): Promise<void> {
    const responses = await Promise.all(requests.map((request) => this.network.fetch(request)))
    const failed = responses.find((response) => !response.ok)
    if (failed) throw new TypeError(`Request failed: ${failed.status}`)
    for (const [index, response] of responses.entries()) await this.put(requests[index] as Request, response)
  }
}

class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>()
  private readonly network: FakeNetwork

  constructor(network: FakeNetwork) {
    this.network = network
  }

  open(name: string): Promise<FakeCache> {
    let cache = this.stores.get(name)
    if (!cache) {
      cache = new FakeCache(this.network)
      this.stores.set(name, cache)
    }
    return Promise.resolve(cache)
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.stores.keys()])
  }

  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.stores.delete(name))
  }

  async match(input: string | Request, options: { cacheName?: string } = {}): Promise<Response | undefined> {
    const names = options.cacheName ? [options.cacheName] : [...this.stores.keys()]
    for (const name of names) {
      const hit = await this.stores.get(name)?.match(input)
      if (hit) return hit
    }
    return undefined
  }
}

/** The server: a body per path, and a log of each request with its cache mode. */
class FakeNetwork {
  readonly requests: { path: string; cache: string }[] = []
  readonly failing = new Set<string>()
  readonly files: Record<string, string>

  constructor(files: Record<string, string>) {
    this.files = files
  }

  fetch(request: Request): Promise<Response> {
    const path = pathOf(request)
    this.requests.push({ path, cache: request.cache })
    const body = this.files[path]
    if (body === undefined || this.failing.has(path)) return Promise.resolve(new Response('missing', { status: 404 }))
    return Promise.resolve(new Response(body, { status: 200 }))
  }
}

type Listener = (event: { waitUntil: (promise: Promise<unknown>) => void }) => void

/** Loads sw.js with `manifest`; `install()` / `activate()` resolve when the worker's waitUntil does. */
function loadWorker(manifest: PrecacheManifest, network: FakeNetwork, cacheStorage = new FakeCacheStorage(network)) {
  const listeners = new Map<string, Listener>()
  const global: Record<string, unknown> = {
    caches: cacheStorage,
    fetch: (input: Request) => network.fetch(input),
    // Relative URLs resolve against the worker's origin, as in a browser.
    Request: class extends Request {
      constructor(input: string | Request, init?: RequestInit) {
        super(typeof input === 'string' ? new URL(input, ORIGIN) : input, init)
      }
    },
    Response,
    URL,
    location: new URL(`${ORIGIN}/sw.js`),
    clients: { claim: () => Promise.resolve() },
    skipWaiting: () => Promise.resolve(),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    importScripts: (url: string) => {
      expect(url).toBe('/sw-precache-manifest.js')
      global.VMS_PRECACHE_MANIFEST = manifest
    },
  }
  global.self = global
  runInNewContext(WORKER_SOURCE, global)

  const dispatch = async (type: string) => {
    const pending: Promise<unknown>[] = []
    listeners.get(type)?.({ waitUntil: (promise) => pending.push(promise) })
    await Promise.all(pending)
  }
  return { cacheStorage, install: () => dispatch('install'), activate: () => dispatch('activate') }
}

const FILES = {
  '/index.html': '<html>v2</html>',
  '/manifest.webmanifest': '{"name":"VMS"}',
  '/assets/react-AAAA.js': 'react',
  '/assets/index-NEW1.js': 'app v2',
  '/assets/zxing_reader-WWWW.wasm': 'wasm',
}

const MANIFEST: PrecacheManifest = {
  version: 'v2',
  urls: Object.keys(FILES).toSorted(),
  immutable: ['/assets/index-NEW1.js', '/assets/react-AAAA.js', '/assets/zxing_reader-WWWW.wasm'],
}

describe('service worker precache', () => {
  it('first install: fetches every file once, hashed files through the HTTP cache, the others from the server', async () => {
    const network = new FakeNetwork(FILES)
    const worker = loadWorker(MANIFEST, network)

    await worker.install()

    expect(network.requests.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: '/assets/index-NEW1.js', cache: 'default' },
      { path: '/assets/react-AAAA.js', cache: 'default' },
      { path: '/assets/zxing_reader-WWWW.wasm', cache: 'default' },
      { path: '/index.html', cache: 'reload' },
      { path: '/manifest.webmanifest', cache: 'reload' },
    ])
    const cache = worker.cacheStorage.stores.get('vms-precache-v2')
    expect([...(cache?.entries.keys() ?? [])].toSorted()).toEqual(MANIFEST.urls)
  })

  it('update: copies unchanged hashed files from the previous cache and downloads only the rest', async () => {
    const network = new FakeNetwork(FILES)
    const cacheStorage = new FakeCacheStorage(network)
    const previous = await cacheStorage.open('vms-precache-v1')
    for (const [path, body] of Object.entries({
      '/index.html': '<html>v1</html>',
      '/manifest.webmanifest': '{"name":"VMS"}',
      '/assets/react-AAAA.js': 'react (cached)',
      '/assets/index-OLD1.js': 'app v1',
      '/assets/zxing_reader-WWWW.wasm': 'wasm (cached)',
    })) {
      await previous.put(path, new Response(body))
    }
    const worker = loadWorker(MANIFEST, network, cacheStorage)

    await worker.install()

    // The changed app chunk (new name) and the files whose names never change; not the vendor
    // chunk or the decoder, although the cache name changed.
    expect(network.requests.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: '/assets/index-NEW1.js', cache: 'default' },
      { path: '/index.html', cache: 'reload' },
      { path: '/manifest.webmanifest', cache: 'reload' },
    ])
    const current = cacheStorage.stores.get('vms-precache-v2')
    expect(await (await current?.match('/assets/react-AAAA.js'))?.text()).toBe('react (cached)')
    expect(await (await current?.match('/assets/zxing_reader-WWWW.wasm'))?.text()).toBe('wasm (cached)')
    // Same URL, new content: never taken from the old cache.
    expect(await (await current?.match('/index.html'))?.text()).toBe('<html>v2</html>')
    expect(current?.entries.has('/assets/index-OLD1.js')).toBe(false)

    await worker.activate()
    expect([...cacheStorage.stores.keys()]).toEqual(['vms-precache-v2'])
  })

  it('a failed download fails the install; the retry keeps what the first attempt stored', async () => {
    const network = new FakeNetwork(FILES)
    network.failing.add('/assets/zxing_reader-WWWW.wasm')
    const cacheStorage = new FakeCacheStorage(network)
    const first = loadWorker(MANIFEST, network, cacheStorage)

    await expect(first.install()).rejects.toThrow('Request failed: 404')

    network.failing.clear()
    network.requests.length = 0
    await loadWorker(MANIFEST, network, cacheStorage).install()

    expect(network.requests.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: '/assets/zxing_reader-WWWW.wasm', cache: 'default' },
      { path: '/index.html', cache: 'reload' },
      { path: '/manifest.webmanifest', cache: 'reload' },
    ])
    expect([...(cacheStorage.stores.get('vms-precache-v2')?.entries.keys() ?? [])].toSorted()).toEqual(MANIFEST.urls)
  })
})

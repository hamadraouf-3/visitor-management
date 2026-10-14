/*
 * The «زوار موضوع» / Mawdoo3 Visitors service worker (§10 PWA).
 *
 * - Precaches the built static assets, including the self-hosted zxing .wasm. The list, the
 *   content-hashed subset and a version come from sw-precache-manifest.js, generated at build
 *   time by config/serviceWorkerPrecache.ts.
 * - A new version downloads only what changed: a content-hashed file (/assets/*, its URL changes
 *   with its content) is copied from the previous version's cache, or comes from the browser's
 *   HTTP cache, where the page itself may just have loaded it. Files whose URL stays the same
 *   (index.html, the web manifest, icons) are always fetched from the server.
 * - Navigations are network-first; offline they fall back to the precached app shell.
 * - /api is never intercepted or cached.
 * - Caches of previous versions are deleted on activation.
 * - Staff pages register it; the visitor pass page does not (src/pwa/registerServiceWorker.ts).
 */
importScripts('/sw-precache-manifest.js')

const { version, urls, immutable } = self.VMS_PRECACHE_MANIFEST
const CACHE_PREFIX = 'vms-precache-'
const CACHE_NAME = `${CACHE_PREFIX}${version}`
const APP_SHELL = '/index.html'
const PRECACHED_PATHS = new Set(urls)
const IMMUTABLE_PATHS = new Set(immutable)

async function previousCaches() {
  const names = await caches.keys()
  return Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.open(name)))
}

async function precache(cache, previous, url) {
  if (!IMMUTABLE_PATHS.has(url)) {
    // Bypass the HTTP cache so a new version never precaches a stale copy of a file whose URL
    // does not change with its content.
    await cache.add(new Request(url, { cache: 'reload' }))
    return
  }
  // Already here from an earlier, interrupted install of this version, or in an older cache:
  // the same URL is the same content.
  if (await cache.match(url)) return
  for (const older of previous) {
    const response = await older.match(url)
    if (response) {
      await cache.put(url, response)
      return
    }
  }
  // Default cache mode: the HTTP cache may answer (the server marks /assets/* immutable).
  await cache.add(new Request(url))
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME)
      const previous = await previousCaches()
      // A failed file fails the install; the active version keeps serving, and the next update
      // check retries (keeping what this attempt already stored).
      await Promise.all(urls.map((url) => precache(cache, previous, url)))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(
        names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)),
      )
      await self.clients.claim()
    })(),
  )
})

function isApiRequest(url) {
  return url.pathname === '/api' || url.pathname.startsWith('/api/')
}

async function networkFirstNavigation(request) {
  try {
    return await fetch(request)
  } catch (error) {
    const shell = await caches.match(APP_SHELL, { cacheName: CACHE_NAME })
    if (shell) return shell
    throw error
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request, { cacheName: CACHE_NAME })
  return cached ?? fetch(request)
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin || isApiRequest(url)) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request))
    return
  }
  if (PRECACHED_PATHS.has(url.pathname)) {
    event.respondWith(cacheFirst(request))
  }
})

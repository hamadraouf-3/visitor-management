// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { PRECACHE_MANIFEST_FILE, serviceWorkerPrecache, type PrecacheManifest } from './serviceWorkerPrecache.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** A public directory with the worker, the web manifest and an icon. */
function publicDir(worker = 'self.addEventListener("fetch", () => {})') {
  const directory = mkdtempSync(path.join(tmpdir(), 'vms-precache-'))
  directories.push(directory)
  mkdirSync(path.join(directory, 'icons'))
  writeFileSync(path.join(directory, 'sw.js'), worker)
  writeFileSync(path.join(directory, 'manifest.webmanifest'), '{"name":"VMS"}')
  writeFileSync(path.join(directory, 'icons', 'icon-192.png'), 'png')
  return directory
}

const BUNDLE = {
  'index.html': { type: 'asset', source: '<html></html>' },
  'assets/index-AbC123.js': { type: 'chunk', code: 'app()' },
  'assets/index-AbC123.js.map': { type: 'asset', source: '{}' },
  'assets/index-DeF456.css': { type: 'asset', source: 'body{}' },
  'assets/zxing_reader-GhI789.wasm': { type: 'asset', source: new Uint8Array([0, 97, 115, 109]) },
}

/** Runs the plugin's build hooks the way Vite does and returns the manifest it emits. */
function emitManifest(publicDirectory: string, bundle: object = BUNDLE): PrecacheManifest {
  const plugin = serviceWorkerPrecache()
  const configResolved = plugin.configResolved as (config: unknown) => void
  configResolved({ base: '/', publicDir: publicDirectory, build: { assetsDir: 'assets' } })

  const emitted: { fileName: string; source: string }[] = []
  const generateBundle = plugin.generateBundle as (this: unknown, options: unknown, bundle: unknown) => void
  generateBundle.call({ emitFile: (file: { fileName: string; source: string }) => emitted.push(file) }, {}, bundle)

  expect(emitted.map((file) => file.fileName)).toEqual([PRECACHE_MANIFEST_FILE])
  const scope: { VMS_PRECACHE_MANIFEST?: PrecacheManifest } = {}
  runInNewContext(emitted[0]?.source ?? '', { self: scope })
  if (!scope.VMS_PRECACHE_MANIFEST) throw new Error('No manifest emitted')
  return scope.VMS_PRECACHE_MANIFEST
}

describe('service worker precache manifest', () => {
  it('lists the bundle, the public files and the app shell, and marks only the hashed bundle files immutable', () => {
    const manifest = emitManifest(publicDir())

    expect(manifest.urls).toEqual([
      '/assets/index-AbC123.js',
      '/assets/index-DeF456.css',
      '/assets/zxing_reader-GhI789.wasm',
      '/icons/icon-192.png',
      '/index.html',
      '/manifest.webmanifest',
    ])
    // index.html, the web manifest and the icons keep their names from one version to the next.
    expect(manifest.immutable).toEqual(['/assets/index-AbC123.js', '/assets/index-DeF456.css', '/assets/zxing_reader-GhI789.wasm'])
  })

  it('gives a changed worker a new version, so it never shares a cache with the previous one', () => {
    const before = emitManifest(publicDir('/* v1 */'))
    const after = emitManifest(publicDir('/* v2 */'))

    expect(after.urls).toEqual(before.urls)
    expect(after.version).not.toBe(before.version)
    expect(emitManifest(publicDir('/* v1 */')).version).toBe(before.version)
  })
})

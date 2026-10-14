import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'

/** Script imported by `public/sw.js`; defines `self.VMS_PRECACHE_MANIFEST`. */
export const PRECACHE_MANIFEST_FILE = 'sw-precache-manifest.js'

/** The service worker script in the public directory. */
const SERVICE_WORKER_FILE = 'sw.js'

/** Files that must never be precached: the worker itself and its own manifest. */
const EXCLUDED_FILES = new Set([SERVICE_WORKER_FILE, PRECACHE_MANIFEST_FILE])

export interface PrecacheManifest {
  /** Content hash of every precached file and of the worker: names the version's cache. */
  version: string
  /** Every URL to precache, sorted. */
  urls: string[]
  /**
   * The URLs among `urls` whose name carries a hash of their content (the bundle's files in
   * `build.assetsDir`, which the server also marks immutable): the same URL is always the same
   * file, so the worker may take it from an older cache or the browser's HTTP cache. Every other
   * URL keeps its name across versions and is always fetched again.
   */
  immutable: string[]
}

function listFilesRecursive(root: string, dir = root): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return listFilesRecursive(root, fullPath)
    return [path.relative(root, fullPath).split(path.sep).join('/')]
  })
}

/**
 * Emits the service worker precache manifest at build time: every emitted bundle file
 * (JS, CSS, the zxing `.wasm`, other assets), every public file and the app shell.
 * The version is a content hash, so each deploy activates a fresh cache and the worker
 * deletes the previous one; files whose hashed name did not change are carried over
 * instead of being downloaded again.
 */
export function serviceWorkerPrecache(): Plugin {
  let config: ResolvedConfig

  return {
    name: 'vms:service-worker-precache',
    apply: 'build',
    enforce: 'post',
    configResolved(resolved) {
      config = resolved
    },
    generateBundle(_options, bundle) {
      const hash = createHash('sha256')
      const files = new Set<string>(['index.html'])
      const hashedFiles = new Set<string>()
      const assetsPrefix = `${config.build.assetsDir.replace(/^\/+|\/+$/g, '')}/`

      for (const [fileName, output] of Object.entries(bundle)) {
        if (fileName.endsWith('.map') || EXCLUDED_FILES.has(fileName)) continue
        files.add(fileName)
        if (fileName.startsWith(assetsPrefix)) hashedFiles.add(fileName)
        hash.update(fileName)
        hash.update(output.type === 'chunk' ? output.code : output.source)
      }

      const publicDir = config.publicDir
      if (publicDir) {
        for (const fileName of listFilesRecursive(publicDir)) {
          if (EXCLUDED_FILES.has(fileName)) continue
          files.add(fileName)
          // A public file keeps its name whatever its content, also inside the assets directory.
          hashedFiles.delete(fileName)
          hash.update(fileName)
          hash.update(readFileSync(path.join(publicDir, fileName)))
        }
        // Not precached, but part of the version: a changed worker gets a cache of its own.
        const worker = path.join(publicDir, SERVICE_WORKER_FILE)
        if (existsSync(worker)) {
          hash.update(SERVICE_WORKER_FILE)
          hash.update(readFileSync(worker))
        }
      }

      const base = config.base.endsWith('/') ? config.base : `${config.base}/`
      const toUrl = (fileName: string) => `${base}${fileName}`
      const manifest: PrecacheManifest = {
        version: hash.digest('hex').slice(0, 16),
        urls: [...files].toSorted().map(toUrl),
        immutable: [...hashedFiles].toSorted().map(toUrl),
      }

      this.emitFile({
        type: 'asset',
        fileName: PRECACHE_MANIFEST_FILE,
        source: `self.VMS_PRECACHE_MANIFEST = ${JSON.stringify(manifest, null, 2)};\n`,
      })
    },
  }
}

// @vitest-environment node
import { fileURLToPath } from 'node:url'
import { resolveConfig } from 'vite'
import { describe, expect, it } from 'vitest'
import viteConfig from '../vite.config.ts'

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url))

// §3: the SPA reaches /api same-origin through the proxy, so neither server may answer CORS
// (Vite installs its CORS middleware unless the resolved `cors` option is exactly false).
describe('dev and preview servers send no CORS headers', () => {
  it('resolves cors: false for `vite` (dev server)', async () => {
    const config = await resolveConfig({ configFile, logLevel: 'silent' }, 'serve', 'development', 'development')
    expect(config.server.cors).toBe(false)
  })

  it('resolves cors: false for `vite preview`', async () => {
    const config = await resolveConfig({ configFile, logLevel: 'silent' }, 'serve', 'production', 'production', true)
    expect(config.preview.cors).toBe(false)
  })

  it.each(['development', 'production', 'https'])('declares cors: false for both servers in %s mode', (mode) => {
    const config = viteConfig({ command: 'serve', mode })
    expect(config.server?.cors).toBe(false)
    expect(config.preview?.cors).toBe(false)
  })
})

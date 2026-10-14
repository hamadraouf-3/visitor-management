// Fails when the nginx security headers drift from the application's own list.
//
//   node deploy/verify/check_nginx_headers.mjs        (Node 24: imports the TypeScript module directly)
//
// frontend/config/securityHeaders.ts is the source of truth for the SPA's headers (contract §10; it is
// what `vite preview` serves and what the CSP compatibility checks ran against). Production serves
// them from deploy/nginx/snippets/security-headers.conf. Every header must be present in both, with the
// same value, exactly once, and with `always` (so error responses carry them too).
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..')
const { SECURITY_HEADERS } = await import(new URL('../../frontend/config/securityHeaders.ts', import.meta.url).href)
const snippetPath = join(repo, 'deploy', 'nginx', 'snippets', 'security-headers.conf')

const LINE = /^add_header\s+([A-Za-z0-9-]+)\s+"([^"]*)"\s+always;$/
const nginx = new Map()
const problems = []
for (const [index, raw] of readFileSync(snippetPath, 'utf8').split(/\r?\n/).entries()) {
  const line = raw.trim()
  if (line === '' || line.startsWith('#')) continue
  const match = LINE.exec(line)
  if (!match) {
    problems.push(`${snippetPath}:${index + 1}: not in the form add_header NAME "VALUE" always; -> ${line}`)
    continue
  }
  const [, name, value] = match
  if (nginx.has(name.toLowerCase())) problems.push(`${name} is set twice in the nginx snippet`)
  nginx.set(name.toLowerCase(), { name, value })
}

const app = new Map(Object.entries(SECURITY_HEADERS).map(([name, value]) => [name.toLowerCase(), { name, value }]))
for (const [key, { name, value }] of app) {
  const served = nginx.get(key)
  if (!served) problems.push(`${name} is in securityHeaders.ts but not in the nginx snippet`)
  else if (served.value !== value) problems.push(`${name} differs:\n  app:   ${value}\n  nginx: ${served.value}`)
}
for (const [key, { name }] of nginx) {
  if (!app.has(key)) problems.push(`${name} is in the nginx snippet but not in securityHeaders.ts`)
}

if (problems.length > 0) {
  console.error(`nginx security headers are out of sync with frontend/config/securityHeaders.ts:\n- ${problems.join('\n- ')}`)
  process.exit(1)
}
console.log(`nginx security headers match frontend/config/securityHeaders.ts (${app.size} headers)`)

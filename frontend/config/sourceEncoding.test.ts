// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const frontendDir = fileURLToPath(new URL('..', import.meta.url))

/** Mirrors .gitignore: dependencies, build output and test reports are not sources. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'dist-ssr', 'coverage', 'test-results', 'playwright-report', '.artifacts', '.git'])
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|css|html|md|svg|webmanifest|txt|ya?ml)$|^\.[\w.-]+rc(?:\.json)?$|^\.gitignore$/

/** Files outside frontend/ that the frontend imports (shared contract data). */
const IMPORTED_FROM_OUTSIDE = ['../docs/contract/pass-token-vectors.json']

/**
 * Characters that are invisible or reorder text where they stand: control characters other
 * than tab/LF/CR, format characters (BOM/U+FEFF, zero-width and bidirectional controls — the
 * "Trojan Source" class), and every space or line separator except U+0020. Write them as
 * `\uXXXX` escapes in code and data, so a reviewer can see them.
 */
const INVISIBLE = /(?![\t\n\r ])[\p{Cc}\p{Cf}\p{Z}]/gu

function listTextFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : listTextFiles(path)
    return entry.isFile() && TEXT_FILE.test(entry.name) ? [path] : []
  })
}

function codePoint(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`
}

/** Problems in one file, as "path:line:column description". */
function encodingProblems(path: string): string[] {
  const bytes = readFileSync(path)
  const name = relative(frontendDir, path).replaceAll('\\', '/')
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return [`${name}:1:1 starts with a UTF-8 byte order mark`]

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return [`${name} is not valid UTF-8`]
  }

  return text.split('\n').flatMap((line, index) =>
    [...line.matchAll(INVISIBLE)].map((match) => `${name}:${index + 1}:${match.index + 1} raw ${codePoint(match[0])}`),
  )
}

describe('source encoding', () => {
  const files = [...listTextFiles(frontendDir), ...IMPORTED_FROM_OUTSIDE.map((path) => join(frontendDir, path))]

  it('finds the sources to check', () => {
    const names = files.map((path) => relative(frontendDir, path).replaceAll('\\', '/'))
    expect(names).toEqual(expect.arrayContaining(['src/scanner/parsePassToken.ts', 'config/securityHeaders.ts', 'package.json', 'index.html']))
    expect(names.some((name) => name.startsWith('node_modules/') || name.startsWith('dist/'))).toBe(false)
  })

  it('is UTF-8 without a byte order mark or raw invisible characters', () => {
    expect(files.flatMap(encodingProblems), 'Re-save as UTF-8 without BOM; write invisible characters as \\uXXXX escapes').toEqual([])
  })

  it('flags each kind of problem it is meant to catch', () => {
    expect('a\u00A0b\u200Bc\u202Ed\uFEFFe\u2028f\u0007g'.match(INVISIBLE)).toEqual(['\u00A0', '\u200B', '\u202E', '\uFEFF', '\u2028', '\u0007'])
    expect('tab\tspace §–…é→ مرحبا\r'.match(INVISIBLE)).toBeNull()
  })
})

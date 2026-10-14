// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceDir = fileURLToPath(new URL('../src', import.meta.url))

/**
 * Reversing a flex row or column (Tailwind `flex-row-reverse`, `flex-col-reverse`, with any
 * variant) shows controls in another order than the DOM, which keyboard and screen-reader users
 * follow, so Tab moves against the visual order (WCAG 2.4.3, 1.3.2). The kit's rule is the
 * reading order everywhere: the safe choice first, the primary action last (Phase 2–4 decision
 * 46, FE57-13).
 */
const REVERSED_FLEX = /\b(?:[\w-]+:)*flex-(?:row|col)-reverse\b/g

function listComponentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listComponentFiles(path)
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('visual order follows the DOM order', () => {
  it('uses no reversed flex row or column in any component', () => {
    const problems = listComponentFiles(sourceDir).flatMap((path) => {
      const name = relative(sourceDir, path).replaceAll('\\', '/')
      return readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line, index) => [...line.matchAll(REVERSED_FLEX)].map((match) => `${name}:${index + 1} ${match[0]}`))
    })
    expect(problems).toEqual([])
  })
})

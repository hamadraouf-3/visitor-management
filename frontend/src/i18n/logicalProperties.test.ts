// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceDir = fileURLToPath(new URL('..', import.meta.url))

/**
 * Every source under `src/` is laid out with logical properties only (F10-10): the layout
 * mirrors in Arabic because sides are named by the reading direction (`ms-`/`me-`, `ps-`/`pe-`,
 * `start-`/`end-`, `text-start`/`text-end`, `rounded-s`/`rounded-e`, `border-s`/`border-e`),
 * never left or right. Tests are not checked. A class that must name a physical side (none
 * today: a chart mirrors through its own coordinates) is listed in `ALLOWED` as
 * "path class" with the reason.
 */
const ALLOWED: Readonly<Record<string, string>> = {}

/**
 * Tailwind utilities that name a physical side, with any variant prefix: margin, padding, inset,
 * text alignment, border and radius sides, and float/clear. `left-1/2 -translate-x-1/2` centring
 * is direction-neutral and allowed.
 */
const PHYSICAL =
  /(?<![\w-])(?:[\w-]+:)*-?(?:m[lr]|p[lr]|left|right|border-[lr]|rounded-(?:[lr]|tl|tr|bl|br)|scroll-m[lr]|scroll-p[lr])-(?!1\/2\b)[\w./[\]-]+|(?<![\w-])(?:[\w-]+:)*(?:text-(?:left|right)|float-(?:left|right)|clear-(?:left|right)|border-[lr]|rounded-[lr])(?![\w-])/g

function listSources(path: string): string[] {
  if (statSync(path).isFile()) return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : []
  return readdirSync(path).flatMap((name) => listSources(join(path, name)))
}

/** Class-like tokens in string literals (quotes or backticks), as "path:line class". */
function physicalClasses(path: string, source = readFileSync(path, 'utf8')): string[] {
  const name = relative(sourceDir, path).replaceAll('\\', '/')
  return source.split('\n').flatMap((line, index) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return []
    const strings = [...line.matchAll(/(['"`])((?:(?!\1).)*)\1/g)].map((match) => match[2] ?? '')
    return strings.flatMap((text) => [...text.matchAll(PHYSICAL)].map((match) => `${name}:${index + 1} ${match[0]}`))
  })
}

describe('logical properties (right-to-left layout)', () => {
  it('recognises physical sides and leaves logical ones alone (self-check)', () => {
    const sample = [
      `const a = 'ml-2 pe-3 sm:pr-4 -mr-1 text-left md:text-right rounded-r-md border-l'`,
      `const b = "ms-2 ps-3 end-0 start-3 text-start rounded-e-control border-s"`,
      `const c = 'absolute left-1/2 -translate-x-1/2 right-0 lg:left-3'`,
    ].join('\n')
    expect(physicalClasses(join(sourceDir, 'sample.tsx'), sample)).toEqual([
      'sample.tsx:1 ml-2',
      'sample.tsx:1 sm:pr-4',
      'sample.tsx:1 -mr-1',
      'sample.tsx:1 text-left',
      'sample.tsx:1 md:text-right',
      'sample.tsx:1 rounded-r-md',
      'sample.tsx:1 border-l',
      'sample.tsx:3 right-0',
      'sample.tsx:3 lg:left-3',
    ])
  })

  it('finds none in any source of the app', () => {
    const files = listSources(sourceDir)
    expect(files.length).toBeGreaterThan(250)
    const found = files.flatMap((path) => physicalClasses(path)).filter((problem) => !(problem.replace(/:\d+ /, ' ') in ALLOWED))
    expect(found).toEqual([])
  })
})

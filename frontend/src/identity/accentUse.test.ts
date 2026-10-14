// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceDir = fileURLToPath(new URL('..', import.meta.url))

/**
 * `accent` is a company's own colour as a FILL (F12-29): the yellow of a yellow company, under its
 * ink `on-accent`. It promises to carry that ink and nothing else: on a white card it may be
 * invisible (yellow on white is 1.8:1). So a class may use it in two ways only:
 *
 * - as a background, in a class list that sets the text to `text-on-accent`;
 * - as the border of that same fill (`border-accent` beside `bg-accent`), or as the text of the
 *   inverse pair (`text-accent` on `bg-on-accent`).
 *
 * A line, a mark or a text in the brand's colour on the content area is `accent-strong`,
 * `accent-text` or `accent-border`, which show on white for every colour. Tests are not checked.
 */
const VARIANTS = String.raw`(?<![\w-])(?:[\w\-[\]&=."']+:)*`
const BARE = String.raw`-accent(?:-hover)?(?:\/\d+)?(?![\w-])`
const MARK = new RegExp(`${VARIANTS}(border(?:-[setblrxy])?|text|fill|stroke|ring|inset-ring|outline|decoration|divide|caret|accent|shadow|from|via|to)${BARE}`, 'g')
const FILL = new RegExp(`${VARIANTS}bg${BARE}`, 'g')
const has = (text: string, name: string) => new RegExp(String.raw`(?<![\w:-])${name}(?![\w-])`).test(text)

function listSources(path: string): string[] {
  if (statSync(path).isFile()) return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : []
  return readdirSync(path).flatMap((name) => listSources(join(path, name)))
}

/** Uses of the bare accent that its promise does not cover, as "path:line class". */
function looseAccents(path: string, source = readFileSync(path, 'utf8')): string[] {
  const name = relative(sourceDir, path).replaceAll('\\', '/')
  return source.split('\n').flatMap((line, index) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return []
    const strings = [...line.matchAll(/(['"`])((?:(?!\1).)*)\1/g)].map((match) => match[2] ?? '')
    return strings.flatMap((text) => {
      const marks = [...text.matchAll(MARK)].filter((match) => {
        if (match[1]!.startsWith('border')) return !has(text, 'bg-accent')
        if (match[1] === 'text') return !has(text, 'bg-on-accent')
        return true
      })
      const fills = has(text, 'text-on-accent') ? [] : [...text.matchAll(FILL)]
      return [...marks, ...fills].map((match) => `${name}:${index + 1} ${match[0]}`)
    })
  })
}

describe('the brand’s fill colour is used as a fill only', () => {
  it('recognises a line, a mark and a bare fill, and leaves the pairs and the other accent tokens alone (self-check)', () => {
    const sample = [
      `const a = 'border-accent text-fg'`,
      `const b = 'data-checked:border-accent accent-accent fill-accent-hover text-accent/80'`,
      `const c = "h-2 rounded-full bg-accent"`,
      `const d = 'bg-accent text-on-accent hover:bg-accent-hover disabled:hover:bg-accent inset-ring-accent-edge'`,
      `const e = 'border-accent bg-accent text-on-accent'`,
      `const f = 'bg-on-accent text-accent'`,
      `const g = 'border-accent-strong text-accent-text bg-accent-surface border-accent-border fill-accent-strong-hover accent-accent-strong'`,
      `// a comment may name bg-accent and border-accent`,
    ].join('\n')
    expect(looseAccents(join(sourceDir, 'sample.tsx'), sample)).toEqual([
      'sample.tsx:1 border-accent',
      'sample.tsx:2 data-checked:border-accent',
      'sample.tsx:2 accent-accent',
      'sample.tsx:2 fill-accent-hover',
      'sample.tsx:2 text-accent/80',
      'sample.tsx:3 bg-accent',
    ])
  })

  it('finds no other use in any source of the app', () => {
    const files = listSources(sourceDir)
    expect(files.length).toBeGreaterThan(250)
    expect(files.flatMap((path) => looseAccents(path))).toEqual([])
  })
})

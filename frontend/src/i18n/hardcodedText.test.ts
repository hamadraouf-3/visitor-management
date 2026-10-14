// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const sourceDir = fileURLToPath(new URL('..', import.meta.url))

/**
 * Every source under `src/` must take its user-facing text from the catalogs (F10-4): JSX text,
 * string literals rendered as children, and the attributes people read or hear (labels, titles,
 * placeholders, alternative text) go through `t()`. Tests are not checked.
 *
 * The whole app is translated, so the check covers all of it: a new screen cannot ship English
 * into the Arabic UI. A source that must keep a literal (none today) is listed in `ALLOWED`,
 * with the reason, by its path relative to `src/`.
 */
const ALLOWED: Readonly<Record<string, string>> = {}

/** Attributes and props whose string value a person reads or hears. */
const USER_FACING_ATTRIBUTES = new Set([
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'aria-placeholder',
  'alt',
  'title',
  'placeholder',
  'label',
  'description',
  'hint',
  'error',
  'legend',
  'caption',
  'heading',
  'eyebrow',
  'triggerLabel',
  'copiedLabel',
  'failureMessage',
  'emptyMessage',
  'idleMessage',
  'documentTitle',
])

const LETTER = /\p{L}/u

function listSources(path: string): string[] {
  if (statSync(path).isFile()) return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.endsWith('.d.ts') ? [path] : []
  return readdirSync(path).flatMap((name) => listSources(join(path, name)))
}

/** String literals an expression can evaluate to when rendered as JSX children. */
function renderedStrings(expression: ts.Expression): ts.Node[] {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression]
  if (ts.isTemplateExpression(expression)) return [expression]
  if (ts.isParenthesizedExpression(expression)) return renderedStrings(expression.expression)
  if (ts.isConditionalExpression(expression)) return [...renderedStrings(expression.whenTrue), ...renderedStrings(expression.whenFalse)]
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return renderedStrings(expression.right)
    if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
      return [...renderedStrings(expression.left), ...renderedStrings(expression.right)]
    }
  }
  return []
}

/** The literal text of a string or template literal (template parts without the substitutions). */
function literalText(node: ts.Node): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ')
  return ''
}

/** Hard-coded user-facing text in one file, as "path:line text". */
function findHardcodedText(path: string, source: string = readFileSync(path, 'utf8')): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const name = relative(sourceDir, path).replaceAll('\\', '/')
  const problems: string[] = []
  const report = (node: ts.Node, text: string) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
    problems.push(`${name}:${line + 1} ${JSON.stringify(text.trim())}`)
  }

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && LETTER.test(node.text)) report(node, node.text)
    if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const literal of renderedStrings(node.expression)) {
        const text = literalText(literal)
        if (LETTER.test(text)) report(literal, text)
      }
    }
    if (ts.isJsxAttribute(node) && USER_FACING_ATTRIBUTES.has(node.name.getText(file)) && node.initializer) {
      const { initializer } = node
      const literals = ts.isStringLiteral(initializer)
        ? [initializer]
        : ts.isJsxExpression(initializer) && initializer.expression
          ? renderedStrings(initializer.expression)
          : []
      for (const literal of literals) {
        const text = literalText(literal)
        if (LETTER.test(text)) report(literal, text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return problems
}

describe('hard-coded user-facing text', () => {
  it('finds JSX text, rendered literals and readable attributes (self-check)', () => {
    const sample = `
      export function Sample({ count }: { count: number }) {
        return (
          <section aria-label="Filters" className="flex gap-2">
            <h2>Results</h2>
            <p>{count === 0 ? 'No results' : t('pagination.showing')}</p>
            <input placeholder={\`Search \${count}\`} type="search" />
            {' · '}
            <span title={t('ok')}>{count}</span>
          </section>
        )
      }`
    expect(findHardcodedText(join(sourceDir, 'sample.tsx'), sample)).toEqual([
      'sample.tsx:4 "Filters"',
      'sample.tsx:5 "Results"',
      'sample.tsx:6 "No results"',
      'sample.tsx:7 "Search"',
    ])
  })

  it('finds none in any source of the app', () => {
    const files = listSources(sourceDir).filter((path) => !(relative(sourceDir, path).replaceAll('\\', '/') in ALLOWED))
    expect(files.length).toBeGreaterThan(250)
    expect(files.flatMap((path) => findHardcodedText(path))).toEqual([])
  })
})

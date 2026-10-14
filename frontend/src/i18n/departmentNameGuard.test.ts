// @vitest-environment node
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { beforeAll, describe, expect, it } from 'vitest'

const sourceDir = fileURLToPath(new URL('..', import.meta.url))
const API_TYPES = 'types/api.ts'
const HELPER = 'i18n/departmentName.ts'

/**
 * A department is named in the UI language (phase 10 shared contract B, F10-dept-2): its Arabic name
 * in the Arabic UI when it has one, else `name`. Only `i18n/departmentName.ts` applies that rule, so
 * no other source may read a department's `name` to show it: a `.name` (or a destructured `name`)
 * on any value typed as `DepartmentRef`, `Department` or a report's department row is reported,
 * whatever the variable is called (`visit.department.name`, `host.department?.name`, `item.name`,
 * `({ id, name }) => …`). The type checker decides what the value is, so a rename cannot hide one.
 *
 * Tests and test support (`src/test/`, `testing/` folders, `testRoutes.ts`) are not checked. A
 * source that must read the raw name is listed in `ALLOWED`, with the reason, by its path relative
 * to `src/`.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'i18n/departmentName.ts': 'the display rule itself',
  'features/admin/departmentForm.ts':
    'the department dialog edits the two names as they are stored, and a duplicate is found by the stored names (unique per company, ignoring case)',
}

function isTestSupport(path: string): boolean {
  return /\.test\.tsx?$/.test(path) || path.startsWith('test/') || path.includes('/testing/') || path.endsWith('/testRoutes.ts')
}

function listSources(path: string): string[] {
  if (statSync(path).isFile()) return /\.tsx?$/.test(path) && !path.endsWith('.d.ts') ? [path] : []
  return readdirSync(path).flatMap((name) => listSources(join(path, name)))
}

const relativePath = (path: string) => relative(sourceDir, path).replaceAll('\\', '/')

/**
 * The declarations of a department's `name`: in api.ts `DepartmentRef`, `Department` and
 * `ReportSummary.by_department`; the helper's own `DepartmentNames`.
 */
function isDepartmentNameDeclaration(declaration: ts.Declaration): boolean {
  if (!ts.isPropertySignature(declaration)) return false
  const path = relativePath(declaration.getSourceFile().fileName)
  const owner = declaration.parent
  if (path === HELPER) return ts.isInterfaceDeclaration(owner) && owner.name.text === 'DepartmentNames'
  if (path !== API_TYPES) return false
  if (ts.isInterfaceDeclaration(owner)) return owner.name.text === 'DepartmentRef' || owner.name.text === 'Department'
  // by_department: { … name: string … }[]
  return ts.isTypeLiteralNode(owner) && ts.isArrayTypeNode(owner.parent) && ts.isPropertySignature(owner.parent.parent) && owner.parent.parent.name.getText() === 'by_department'
}

function isDepartmentName(symbol: ts.Symbol | undefined): boolean {
  return symbol?.declarations?.some(isDepartmentNameDeclaration) ?? false
}

/** Every read of a department's `name` in one source file, as "path:line code". */
function findDepartmentNameReads(program: ts.Program, file: ts.SourceFile): string[] {
  const checker = program.getTypeChecker()
  const found: string[] = []
  const report = (node: ts.Node) => {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
    found.push(`${relativePath(file.fileName)}:${line + 1} ${node.getText(file)}`)
  }
  const propertyOf = (expression: ts.Node, name: string) => checker.getPropertyOfType(checker.getNonNullableType(checker.getTypeAtLocation(expression)), name)

  const visit = (node: ts.Node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'name') {
      if (isDepartmentName(checker.getSymbolAtLocation(node.name) ?? propertyOf(node.expression, 'name'))) report(node)
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'name') {
      if (isDepartmentName(propertyOf(node.expression, 'name'))) report(node)
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const property = node.propertyName ?? node.name
      if ((ts.isIdentifier(property) || ts.isStringLiteralLike(property)) && property.text === 'name' && isDepartmentName(propertyOf(node.parent, 'name'))) {
        report(node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** A source that reads department names in every way the check must see, and two names it must not report. */
const SAMPLE_PATH = 'features/departmentNameSample.tsx'
const SAMPLE = `
import type { Department, DepartmentRef, ReportSummary, Visit } from '../types/api'
export function Sample({ visit, departments, report, extra }: { visit: Visit; departments: Department[]; report: ReportSummary; extra: DepartmentRef & { inactive: boolean } }) {
  const kept = visit.department
  const { name } = departments[0]!
  const company = { name: 'Mawdoo3', name_ar: 'موضوع' }
  return (
    <p title={kept!.name}>
      {visit.department?.name}
      {departments.map((one) => one.name)}
      {report.by_department.map((row) => row['name'])}
      {name}
      {extra.name}
      {visit.host.full_name}
      {company.name}
    </p>
  )
}
`

let options: ts.CompilerOptions
let program: ts.Program
let checked: ts.SourceFile[]

beforeAll(() => {
  const config = ts.getParsedCommandLineOfConfigFile(fileURLToPath(new URL('../../tsconfig.app.json', import.meta.url)), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    },
  })
  if (!config) throw new Error('Cannot read tsconfig.app.json')
  options = { ...config.options, noEmit: true, incremental: false, tsBuildInfoFile: undefined }
  const sources = listSources(sourceDir).filter((path) => !isTestSupport(relativePath(path)))
  program = ts.createProgram(sources, options)
  checked = program.getSourceFiles().filter((file) => {
    const path = relativePath(file.fileName)
    return !path.startsWith('..') && !isTestSupport(path) && !(path in ALLOWED)
  })
}, 120_000)

describe('department names are shown through i18n/departmentName.ts', () => {
  it('no other source reads a department’s name', () => {
    expect(checked.length).toBeGreaterThan(100)
    expect(checked.flatMap((file) => findDepartmentNameReads(program, file))).toEqual([])
  })

  it('finds every way of reading a department’s name, and no other name (self-check)', () => {
    const samplePath = join(sourceDir, SAMPLE_PATH).replaceAll('\\', '/')
    const isSample = (fileName: string) => fileName.replaceAll('\\', '/') === samplePath
    const host = ts.createCompilerHost(options)
    const sampleProgram = ts.createProgram({
      rootNames: [samplePath],
      options,
      oldProgram: program,
      host: {
        ...host,
        fileExists: (fileName) => isSample(fileName) || host.fileExists(fileName),
        readFile: (fileName) => (isSample(fileName) ? SAMPLE : host.readFile(fileName)),
        getSourceFile: (fileName, language, ...rest) =>
          isSample(fileName) ? ts.createSourceFile(fileName, SAMPLE, language, true, ts.ScriptKind.TSX) : host.getSourceFile(fileName, language, ...rest),
      },
    })
    const sample = sampleProgram.getSourceFile(samplePath)
    expect(sample).toBeDefined()
    const reads = findDepartmentNameReads(sampleProgram, sample!).map((found) => found.slice(found.indexOf(' ') + 1))
    expect(reads).toEqual(['name', 'kept!.name', 'visit.department?.name', 'one.name', "row['name']", 'extra.name'])
  })

  it('every allowed exception still exists and still reads a name (no stale entries)', () => {
    for (const path of Object.keys(ALLOWED)) {
      const file = program.getSourceFile(join(sourceDir, path).replaceAll('\\', '/')) ?? program.getSourceFiles().find((source) => relativePath(source.fileName) === path)
      // Path and finding together, so a failure names the stale entry.
      expect({ path, exists: file !== undefined }).toEqual({ path, exists: true })
      expect({ path, reads: findDepartmentNameReads(program, file!).length > 0 }).toEqual({ path, reads: true })
    }
  })
})

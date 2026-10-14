// @vitest-environment node
import { fileURLToPath } from 'node:url'
import { build, type Plugin, type Rollup } from 'vite'
import { describe, expect, it } from 'vitest'
import { isAppShellModule } from '../vite.config.ts'

/*
 * The production build's chunks (§10): the sign-in and pass pages load only the app shell, and a
 * deploy that changes one page renames only that page's chunk and the entry, so browsers and the
 * service worker keep every other file they already have. The edit also changes the stylesheet,
 * as a page that uses a new Tailwind class does: the one stylesheet holds every page's classes.
 */

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url))
const CHANGED_PAGE = /[\\/]src[\\/]features[\\/]reports[\\/]ReportsPage\.tsx$/
const STYLESHEET = /[\\/]src[\\/]index\.css$/

/** Page modules behind lazy routes: none of them may be part of what the entry loads at start. */
const LAZY_PAGES = [
  /[\\/]features[\\/]admin[\\/](?:AdminDashboard|AuditLog|CompanySettings|Departments|Users|EmailTemplates|EmailTemplate)Page\.tsx$/,
  // Phase 11: the platform owner's area, never downloaded by a company user's browser.
  /[\\/]features[\\/]platform[\\/](?:PlatformLogin|PlatformChangePassword|Companies|NewCompany|Company|PlatformAudit)Page\.tsx$/,
  /[\\/]features[\\/]platform[\\/](?:PlatformRoot|PlatformLayout|RequirePlatformAuth)\.tsx$/,
  // Phase 12: a company's identity and its e-mail texts, edited by the platform owner; the logo's canvas pipeline goes with them.
  /[\\/]features[\\/]platform[\\/](?:CompanyIdentity|CompanyEmailTemplates|CompanyEmailTemplate)Page\.tsx$/,
  /[\\/]identity[\\/]imagePipeline\.ts$/,
  /[\\/]features[\\/](?:history[\\/]History|inside[\\/]Inside|reports[\\/]Reports|reception[\\/]Reception)Page\.tsx$/,
  /[\\/]pages[\\/](?:Visitors|VisitorProfile|MyVisits|InviteVisitor|VisitDetail|Pass)Page\.tsx$/,
]

/** Builds the app in memory; `changePage` adds a statement to the reports page and a rule to the stylesheet. */
async function buildChunks(changePage: boolean): Promise<Rollup.OutputChunk[]> {
  const edit: Plugin = {
    name: 'test:edit-reports-page',
    enforce: 'pre',
    transform(code, id) {
      if (changePage && CHANGED_PAGE.test(id)) return `${code}\nglobalThis.__vmsDeployProbe = 'v2'\n`
      if (changePage && STYLESHEET.test(id)) return `${code}\n.vms-deploy-probe { margin-top: 13px; }\n`
      return undefined
    },
  }
  const result = await build({ configFile, logLevel: 'silent', plugins: [edit], build: { write: false } })
  const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[]
  return outputs.flatMap((output) => output.output.filter((file): file is Rollup.OutputChunk => file.type === 'chunk'))
}

describe('production chunks', () => {
  it('keeps the lazy pages out of the start-up chunks, and renames only the changed page and the entry on a deploy', { timeout: 120_000 }, async () => {
    const before = await buildChunks(false)
    const after = await buildChunks(true)

    // Start-up: the entry and every chunk it imports statically (the browser loads them all at once).
    const byFile = new Map(before.map((chunk) => [chunk.fileName, chunk]))
    const entry = before.find((chunk) => chunk.isEntry)
    const startup = new Set<Rollup.OutputChunk>()
    const visit = (chunk: Rollup.OutputChunk | undefined) => {
      if (!chunk || startup.has(chunk)) return
      startup.add(chunk)
      for (const imported of chunk.imports) visit(byFile.get(imported))
    }
    visit(entry)
    const startupModules = [...startup].flatMap((chunk) => chunk.moduleIds)
    expect(startupModules.filter((id) => LAZY_PAGES.some((page) => page.test(id)))).toEqual([])
    // The lazy pages themselves are all there, each behind an import() in a route table.
    for (const page of LAZY_PAGES) expect(before.some((chunk) => chunk.moduleIds.some((id) => page.test(id)))).toBe(true)

    // Pages share code through the app shell chunk, not the entry (which names them).
    const pageChunks = before.filter((chunk) => chunk.moduleIds.some((id) => LAZY_PAGES.some((page) => page.test(id))))
    for (const chunk of pageChunks) expect(chunk.imports).not.toContain(entry?.fileName)

    const previousNames = new Set(before.map((chunk) => chunk.fileName))
    const renamed = after.filter((chunk) => !previousNames.has(chunk.fileName)).map((chunk) => chunk.fileName.replace(/-[\w-]{8}\.js$/, ''))
    expect(renamed.toSorted()).toEqual(['assets/ReportsPage', 'assets/index'])
  })

  it('puts the app’s own start-up modules in the shell chunk, but not the entry or the route tables', () => {
    const src = 'C:/app/frontend/src'
    expect(isAppShellModule(`${src}/layouts/AppLayout.tsx`)).toBe(true)
    expect(isAppShellModule(`${src}/components/ui/Button.tsx`)).toBe(true)
    expect(isAppShellModule(`${src}/main.tsx`)).toBe(false)
    expect(isAppShellModule(`${src}/router.tsx`)).toBe(false)
    expect(isAppShellModule(`${src}/features/admin/routes.tsx`)).toBe(false)
    expect(isAppShellModule('/app/frontend/node_modules/some-lib/src/index.js')).toBe(false)
    // The stylesheet stays with the entry: a chunk's name also covers its CSS.
    expect(isAppShellModule(`${src}/index.css`)).toBe(false)
  })
})

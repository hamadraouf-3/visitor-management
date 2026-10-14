import { existsSync, readFileSync, rmSync } from 'node:fs'
import { BACKEND_PID_FILE, BACKEND_PORT } from './paths.ts'
import { killTree, waitForPortFree } from './processes.ts'

/**
 * Stops the API server the global setup started: the whole process tree (the venv launcher and the
 * interpreter it spawned on Windows). The run directory (server log, outbox) is kept for inspection;
 * the next run's setup replaces it. Playwright stops the Vite webServer itself.
 */
export default async function globalTeardown() {
  if (!existsSync(BACKEND_PID_FILE)) return
  const pid = Number(readFileSync(BACKEND_PID_FILE, 'utf8'))
  killTree(pid)
  rmSync(BACKEND_PID_FILE, { force: true })
  await waitForPortFree(BACKEND_PORT, 15_000)
  process.stdout.write(`[e2e teardown] API server stopped (pid ${pid}); port ${BACKEND_PORT} is free\n`)
}

import { backendEnv } from './env.ts'
import { BACKEND_DIR, PYTHON } from './paths.ts'
import { run } from './processes.ts'

/** `python -m app.cli <args>` against the E2E database (non-production commands included). */
export async function backendCli(args: readonly string[]): Promise<string> {
  const result = await run(PYTHON, ['-m', 'app.cli', ...args], { cwd: BACKEND_DIR, env: backendEnv(), timeoutMs: 60_000 })
  return result.stdout.trim()
}

/**
 * Moves one visit, its lifecycle timestamps and its passes `minutes` into the past
 * (`cli e2e-time-travel`, B24-61; audited as VISIT_TIME_SHIFTED). The server's own clock is untouched.
 */
export function timeTravel(visitId: string, minutes: number): Promise<string> {
  if (!Number.isInteger(minutes) || minutes < 1) throw new Error(`Time travel needs a whole number of minutes ≥ 1, got ${minutes}`)
  return backendCli(['e2e-time-travel', '--visit-id', visitId, '--minutes', String(minutes)])
}

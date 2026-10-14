import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, openSync, readFileSync } from 'node:fs'
import net from 'node:net'

/*
 * Child processes for the suite (Windows-safe). The backend's venv python.exe on Windows is a
 * launcher that starts the real interpreter as a child, so stopping the server must end the whole
 * process tree (`taskkill /T`), not just the PID Node started.
 */

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs a command to completion; throws with its output when it fails. */
export function run(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; input?: string }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    const timer = setTimeout(() => {
      killTree(child.pid)
      reject(new Error(`${command} ${args.join(' ')} timed out after ${options.timeoutMs} ms\n${stdout}\n${stderr}`))
    }, options.timeoutMs ?? 120_000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const result = { code: code ?? -1, stdout, stderr }
      if (result.code === 0) resolve(result)
      else reject(new Error(`${command} ${args.join(' ')} exited with ${result.code}\n--- stdout\n${stdout}\n--- stderr\n${stderr}`))
    })
    child.stdin.end(options.input ?? '')
  })
}

/** Starts a long-running process with stdout and stderr appended to `logFile`. */
export function startBackground(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; logFile: string }): ChildProcess {
  const log = openSync(options.logFile, 'a')
  try {
    return spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['ignore', log, log] })
  } finally {
    // The child holds its own handle; the parent's copy is not needed any more.
    closeSync(log)
  }
}

/** Ends a process and every process it started. Silent when it is already gone. */
export function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

export async function waitForPortFree(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await isPortFree(port))) {
    if (Date.now() > deadline) throw new Error(`Port ${port} is still in use after ${timeoutMs} ms`)
    await sleep(200)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Last lines of a log file, for error messages. */
export function tail(file: string, lines = 40): string {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines).join('\n')
  } catch {
    return '(no log)'
  }
}

/**
 * Polls `url` until it answers 200. Fails early when `child` exits (its log tail is in the error).
 */
export async function waitForHealthy(url: string, options: { timeoutMs: number; child?: ChildProcess; logFile?: string }): Promise<void> {
  const deadline = Date.now() + options.timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    if (options.child && options.child.exitCode !== null) {
      throw new Error(`The process exited with ${options.child.exitCode} before ${url} answered.\n${options.logFile ? tail(options.logFile) : ''}`)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      if (response.status === 200) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(250)
  }
  throw new Error(`${url} did not become healthy within ${options.timeoutMs} ms (last: ${lastError}).\n${options.logFile ? tail(options.logFile) : ''}`)
}

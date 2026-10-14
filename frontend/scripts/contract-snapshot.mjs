// Regenerates src/types/backend-contract.json from the backend's Pydantic models. The backend
// owns the dump (`python -m app.contract`) and a pytest that fails when this file is stale;
// this wrapper only locates the backend virtualenv on Windows and POSIX.
// Usage: npm run contract:snapshot
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url))
const python = fileURLToPath(
  new URL(process.platform === 'win32' ? '../../backend/.venv/Scripts/python.exe' : '../../backend/.venv/bin/python', import.meta.url),
)

if (!existsSync(python)) {
  console.error(`Backend virtualenv not found at ${python}. Create it and install the backend requirements first.`)
  process.exit(1)
}

const output = fileURLToPath(new URL('../src/types/backend-contract.json', import.meta.url))
const result = spawnSync(python, ['-m', 'app.contract', '--out', output], { cwd: backendDir, stdio: 'inherit' })
if (result.error) {
  console.error(`Could not run ${python}: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)

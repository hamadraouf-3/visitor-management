import path from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 * Where everything the full-stack suite touches lives. The ports are the suite's own (contract §2:
 * automated runs never collide with manual development on 8000/5173) and are bound with strictPort.
 */

export const E2E_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const FRONTEND_DIR = path.dirname(E2E_DIR)
export const REPO_ROOT = path.dirname(FRONTEND_DIR)
export const BACKEND_DIR = path.join(REPO_ROOT, 'backend')

const isWindows = process.platform === 'win32'

/** The backend's own virtual environment (never the `python` on PATH, see contract §1). */
export const PYTHON = process.env.VMS_E2E_PYTHON ?? path.join(BACKEND_DIR, '.venv', isWindows ? 'Scripts' : 'bin', isWindows ? 'python.exe' : 'python')

/** The portable PostgreSQL binaries managed by scripts/db.ps1. */
export const PG_BIN = process.env.VMS_E2E_PG_BIN ?? path.join(REPO_ROOT, '.local', 'pgsql', 'bin')
export const PSQL = path.join(PG_BIN, isWindows ? 'psql.exe' : 'psql')

/** Run artefacts (gitignored): outbox, storage states, server log, generated camera files. */
export const ARTIFACTS_DIR = path.join(E2E_DIR, '.artifacts')
export const RUN_DIR = path.join(ARTIFACTS_DIR, 'run')
export const OUTBOX_DIR = path.join(RUN_DIR, 'outbox')
export const STATE_DIR = path.join(RUN_DIR, 'state')
export const CAMERA_DIR = path.join(RUN_DIR, 'camera')
export const BACKEND_LOG = path.join(RUN_DIR, 'backend.log')
export const BACKEND_PID_FILE = path.join(ARTIFACTS_DIR, 'backend.pid')

export const WEB_PORT = 5199
export const BACKEND_PORT = 8700
/** The SPA origin. Every browser and API-helper request goes through it (the Vite proxy forwards /api). */
export const BASE_URL = `http://127.0.0.1:${WEB_PORT}`
export const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`

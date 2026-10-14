import path from 'node:path'
import { STATE_DIR } from './paths.ts'

/**
 * The accounts `python -m app.cli seed-e2e` creates (backend/app/services/seeding.py): Mawdoo3
 * («موضوع», formerly "Demo Company") with one user per role, and Other Corp for cross-tenant checks.
 * All share SEED_DEMO_PASSWORD. The e-mail addresses did not change with the company's name.
 */
export const ACCOUNTS = {
  admin: { email: 'admin@demo.local', name: 'Amal Haddad', company: 'Mawdoo3' },
  employee: { email: 'host@demo.local', name: 'Omar Khalil', company: 'Mawdoo3' },
  employeeB: { email: 'host2@demo.local', name: 'Lina Saleh', company: 'Mawdoo3' },
  reception: { email: 'reception@demo.local', name: 'Rami Nasser', company: 'Mawdoo3' },
  management: { email: 'management@demo.local', name: 'Nour Abbas', company: 'Mawdoo3' },
  otherAdmin: { email: 'admin@other.local', name: 'Sami Odeh', company: 'Other Corp' },
  otherEmployee: { email: 'host@other.local', name: 'Huda Mansour', company: 'Other Corp' },
  otherReception: { email: 'reception@other.local', name: 'Yousef Darwish', company: 'Other Corp' },
} as const

export type AccountKey = keyof typeof ACCOUNTS

export const ACCOUNT_KEYS = Object.keys(ACCOUNTS) as AccountKey[]

/**
 * The platform owner's account (Phase 11, B11-3): `seed-e2e` creates it with the seed password and no
 * forced change. Not a user of any company; it signs in at /platform/login. Never sign it out, change
 * its password or its language: every platform spec shares its storage state.
 */
export const PLATFORM_ACCOUNT = { email: 'platform@demo.local', name: 'Platform Owner' } as const

/** The platform owner's signed-in browser state, written once per run by the global setup. */
export function platformStorageStatePath(): string {
  return path.join(STATE_DIR, 'platform.json')
}

/** The signed-in browser state of an account, written once per run by the global setup. */
export function storageStatePath(account: AccountKey): string {
  return path.join(STATE_DIR, `${account}.json`)
}

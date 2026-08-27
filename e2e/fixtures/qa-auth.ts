import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// package.json declares "type": "module", so this file (and every
// e2e/**/*.ts file) is transpiled/run as real ESM -- __dirname is not
// defined in that scope (confirmed by actually running the suite
// during this phase's own verification, which surfaced this as a real
// ReferenceError, not a hypothetical). fileURLToPath(import.meta.url)
// is the standard ESM-safe equivalent.
const __dirname = dirname(fileURLToPath(import.meta.url))

// Shared helper for every authenticated E2E spec. Mirrors this
// project's own established Vitest convention (describe.skipIf when
// credentials aren't configured -- see customer360.integration.test.ts
// et al) applied to Playwright: a spec that needs a real logged-in
// session checks whether e2e/setup/mint-qa-sessions.ts has actually
// been run (npm run e2e:setup) and, if not, SKIPS cleanly rather than
// failing the whole suite or silently doing nothing. See
// E2E_TEST_STRATEGY.md for the full explanation of the credential-
// minting mechanism these files depend on.
//
// Usage in a spec file:
//
//   import { test, expect } from '@playwright/test'
//   import { authStatePath, hasMintedSession } from '../fixtures/qa-auth'
//
//   test.describe('club owner: X', () => {
//     test.skip(!hasMintedSession('club-owner'), 'No minted session -- run `npm run e2e:setup` first (needs SUPABASE_SERVICE_ROLE_KEY). See E2E_TEST_STRATEGY.md.')
//     test.use({ storageState: authStatePath('club-owner') })
//
//     test('...', async ({ page }) => { ... })
//   })
//
// test.skip(condition, reason) is Playwright's own documented
// conditional-skip API -- evaluated per test file at collection time,
// reported as "skipped" (with the reason visible in the HTML report),
// never as a silent no-op or a failure.

const AUTH_STATE_DIR = resolve(__dirname, '../.auth-state')

export function authStatePath(fixture: string): string {
  return resolve(AUTH_STATE_DIR, `${fixture}.json`)
}

export function hasMintedSession(fixture: string): boolean {
  return existsSync(authStatePath(fixture))
}

export const QA_ROLE_FIXTURES = [
  'platform-owner',
  'club-owner',
  'club-manager',
  'branch-manager',
  'receptionist',
  'accountant',
  'academy-manager',
  'coach',
  'scanner',
  'customer',
  'guardian',
] as const

export type QaRoleFixture = (typeof QA_ROLE_FIXTURES)[number]

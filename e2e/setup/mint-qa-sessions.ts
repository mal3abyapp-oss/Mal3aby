/**
 * mint-qa-sessions.ts
 *
 * Solves the standing "no safe test-user credential can be typed into
 * a real login form" constraint (docs/PROJECT_STATE.md, restated as a
 * hard rule for this whole engagement) for BROWSER-DRIVEN Playwright
 * E2E tests specifically. The existing RLS-impersonation pattern
 * (set_config('request.jwt.claims', ...)) used throughout this
 * project's own Vitest integration suites only works against a direct
 * Postgres session -- a real browser driven by Playwright cannot forge
 * a JWT claim client-side, it has to hold a real Supabase Auth session
 * the same way a real user's browser would.
 *
 * THE MECHANISM (server-side only, standard/documented Supabase Admin
 * API, never a password typed anywhere):
 *   1. Run ONCE, locally, by a human/CI job that holds the project's
 *      service_role key (never shipped to a browser, never committed --
 *      see docs/PROJECT_RULES.md / SECURITY_ANTI_FRAUD.md's existing
 *      "service_role key must never appear in frontend code" rule,
 *      extended here to "must never appear in a committed file" too).
 *   2. For each QA fixture account, calls
 *      supabase.auth.admin.generateLink({ type: 'magiclink', email })
 *      -- this returns a real, valid action_link/hashed_token WITHOUT
 *      reading, resetting, or even touching that user's actual
 *      encrypted_password at all. It is a completely separate,
 *      Supabase-native session-issuance path.
 *   3. Exchanges that token server-side (verifyOtp with the returned
 *      token_hash) to obtain a real access_token + refresh_token pair
 *      -- the exact same shape of session object a real browser login
 *      would produce.
 *   4. Writes that session into e2e/.auth-state/<fixture-name>.json in
 *      Playwright's own storageState format (an origin + localStorage
 *      entry under Supabase's default storage key
 *      sb-<project-ref>-auth-token). A spec then loads this file via
 *      `test.use({ storageState: ... })` and the browser starts every
 *      test ALREADY authenticated -- it never visits /login, never
 *      submits the login form, never sees or types a password.
 *
 * This file is NEVER run automatically by `npm run test:e2e` (see
 * playwright.config.ts's testIgnore) -- run it explicitly via
 * `npm run e2e:setup` whenever a fresh session is needed (sessions
 * expire; re-run before a suite run if specs start failing on an
 * unexpectedly-logged-out state). e2e/.auth-state/ is gitignored --
 * minted sessions are local, disposable artifacts, never committed.
 *
 * Requires env (see .env.e2e.example):
 *   VITE_SUPABASE_URL          -- same value as .env.local
 *   SUPABASE_SERVICE_ROLE_KEY  -- service_role key, LOCAL/CI SECRET ONLY,
 *                                 never committed, never in frontend code
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// package.json declares "type": "module" -- __dirname is not defined
// in real ESM scope (confirmed live: e2e/fixtures/qa-auth.ts hit this
// exact ReferenceError during this phase's own verification run).
const __dirname = dirname(fileURLToPath(import.meta.url))

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

const AUTH_STATE_DIR = resolve(__dirname, '../.auth-state')

// The real, live QA fixture matrix confirmed to exist in the project's
// single Supabase project (gxkrtlvpjwxhcqdisyob) during this phase's
// investigation -- "QA Full Test Club" (id
// 6ca5315e-e199-4531-9fb1-1df358cda087), the only club in the database
// holding a complete 9-role membership set, each a real confirmed
// auth.users row. See STAGING_ARCHITECTURE.md for the full inventory
// and the platform-access repair this phase applied (or proposed, if
// the live apply was blocked -- see that doc's own status note).
//
// Keyed by a short slug used as both the output filename and the
// Playwright fixture name referenced from spec files.
const QA_FIXTURES: Record<string, string> = {
  'platform-owner': 'mal3aby.qa.platform-owner.20260821@example.com',
  'club-owner': 'mal3aby.qa.club-owner.20260821@example.com',
  'club-manager': 'mal3aby.qa.club-manager.20260821@example.com',
  'branch-manager': 'mal3aby.qa.branch-manager.20260821@example.com',
  receptionist: 'mal3aby.qa.receptionist.20260821@example.com',
  accountant: 'mal3aby.qa.accountant.20260821@example.com',
  'academy-manager': 'mal3aby.qa.academy-manager.20260821@example.com',
  coach: 'mal3aby.qa.coach.20260821@example.com',
  scanner: 'mal3aby.qa.scanner.20260821@example.com',
  customer: 'mal3aby.qa.customer.20260821@example.com',
  guardian: 'mal3aby.qa.guardian.20260821@example.com',
}

function projectRefFromUrl(url: string): string {
  const m = /^https?:\/\/([a-z0-9]+)\.supabase\.co/i.exec(url)
  if (!m) throw new Error(`Could not derive project ref from VITE_SUPABASE_URL: ${url}`)
  return m[1]
}

async function mintSessionFor(admin: SupabaseClient, email: string) {
  // generateLink for an EXISTING user issues a real, one-time sign-in
  // link/token without touching encrypted_password. type: 'magiclink'
  // is the correct type for an already-registered user (as opposed to
  // 'signup', which is for provisioning a brand-new account).
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (linkError || !linkData) {
    throw new Error(`generateLink failed for ${email}: ${linkError?.message}`)
  }

  const tokenHash = linkData.properties?.hashed_token
  if (!tokenHash) {
    throw new Error(`generateLink for ${email} returned no hashed_token -- cannot mint a session`)
  }

  // Exchange the token server-side for a real access/refresh token pair
  // -- same verifyOtp call the /auth/v1/verify redirect would trigger
  // in a browser, done here directly so no browser/UI is ever involved.
  const { data: verifyData, error: verifyError } = await admin.auth.verifyOtp({
    type: 'magiclink',
    token_hash: tokenHash,
  })
  if (verifyError || !verifyData.session) {
    throw new Error(`verifyOtp failed for ${email}: ${verifyError?.message}`)
  }

  return verifyData.session
}

function buildStorageState(projectRef: string, origin: string, session: NonNullable<Awaited<ReturnType<typeof mintSessionFor>>>) {
  // Mirrors the exact shape @supabase/supabase-js's default storage
  // adapter writes to localStorage -- confirmed against
  // src/lib/supabase/client.ts, which uses createClient() with no
  // storage/storageKey overrides, so the default
  // `sb-<project-ref>-auth-token` key applies.
  const storageValue = {
    currentSession: session,
    expiresAt: session.expires_at,
  }

  return {
    cookies: [],
    origins: [
      {
        origin,
        localStorage: [
          {
            name: `sb-${projectRef}-auth-token`,
            value: JSON.stringify(storageValue),
          },
        ],
      },
    ],
  }
}

async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error(
      '[mint-qa-sessions] Missing VITE_SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY.\n' +
        'This script requires the service_role key (LOCAL/CI SECRET ONLY -- never commit it,\n' +
        'never put it in .env.local, never let it reach frontend code). See .env.e2e.example.\n' +
        'Nothing was minted; authenticated E2E specs that depend on e2e/.auth-state/*.json will skip.',
    )
    process.exitCode = 1
    return
  }

  const projectRef = projectRefFromUrl(SUPABASE_URL)
  // Playwright storageState "origin" must match the actual page origin
  // the spec navigates to -- for local runs that's the Vite dev server;
  // E2E_APP_ORIGIN lets a run against a deployed target (workers.dev,
  // a future staging host) mint state for the RIGHT origin instead.
  const appOrigin = process.env.E2E_APP_ORIGIN ?? 'http://localhost:5173'

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  mkdirSync(AUTH_STATE_DIR, { recursive: true })

  const results: { fixture: string; email: string; ok: boolean; error?: string }[] = []

  for (const [fixture, email] of Object.entries(QA_FIXTURES)) {
    try {
      const session = await mintSessionFor(admin, email)
      const state = buildStorageState(projectRef, appOrigin, session)
      const outPath = resolve(AUTH_STATE_DIR, `${fixture}.json`)
      writeFileSync(outPath, JSON.stringify(state, null, 2))
      results.push({ fixture, email, ok: true })
      console.log(`[mint-qa-sessions] OK   ${fixture.padEnd(16)} ${email}`)
    } catch (err) {
      results.push({ fixture, email, ok: false, error: err instanceof Error ? err.message : String(err) })
      console.error(`[mint-qa-sessions] FAIL ${fixture.padEnd(16)} ${email} -- ${err instanceof Error ? err.message : err}`)
    }
  }

  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0) {
    console.error(`\n[mint-qa-sessions] ${failed.length}/${results.length} fixture(s) failed to mint a session.`)
    process.exitCode = 1
  } else {
    console.log(`\n[mint-qa-sessions] All ${results.length} QA fixture sessions minted to ${AUTH_STATE_DIR}`)
  }
}

main()

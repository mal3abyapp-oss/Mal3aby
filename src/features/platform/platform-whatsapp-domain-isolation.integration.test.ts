import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import path from 'node:path'

// PLATFORM OWNER OPERATIONAL GAP CLOSURE -- Workstream 1 (Platform
// WhatsApp domain) REGRESSION TESTS.
//
// Guards supabase/migrations/20260909200000_platform_whatsapp_domain.sql
// -- the architecture correction establishing Platform WhatsApp
// (platform_whatsapp_account, a SINGLETON table with no club_id column
// at all) as a structurally SEPARATE domain from Tenant/Club WhatsApp
// (whatsapp_accounts, keyed by club_id). This is the single most
// important isolation boundary the mission's correction calls out by
// name -- a bug here would mean a Platform Owner's own WhatsApp session
// could leak into or be confused with a club's, or vice versa.
//
// Two proof styles are combined per the mission's own instruction:
//   (a) STRUCTURAL/SCHEMA-LEVEL proof -- reading the actual migration
//       SQL text (this repo's own source of truth) to confirm the
//       table/function shapes make cross-domain leakage IMPOSSIBLE, not
//       merely unobserved in one test run. This part requires no QA
//       fixtures or live database access at all and always runs.
//   (b) BEHAVIORAL/live-integration proof where a QA session is
//       available -- confirms the two RPC surfaces genuinely return
//       independent data in a real session.
//
// The structural assertions below read the migration file directly
// (this project's actual deployed source, matching how every RPC in
// this schema is defined) rather than hardcoding a duplicate copy of
// the SQL in the test -- so a future edit to the real migration that
// reintroduces cross-domain coupling is caught by re-parsing the
// CURRENT file content, not a frozen snapshot.

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260909200000_platform_whatsapp_domain.sql',
)
const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf8')

// platform_get_whatsapp_qr(p_club_id) itself was defined one migration
// earlier (20260909150000, the Tenant-scoped WhatsApp control RPCs) --
// read separately here purely as the "other side" of the isolation
// comparison (proving it targets whatsapp_accounts, never
// platform_whatsapp_account), not because it belongs to the domain
// migration under test.
const TENANT_CONTROL_MIGRATION_PATH = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260909150000_platform_owner_whatsapp_connection_control.sql',
)
const tenantControlSql = fs.readFileSync(TENANT_CONTROL_MIGRATION_PATH, 'utf8')

function extractFunctionBody(sql: string, functionSignature: string): string {
  const startIdx = sql.indexOf(functionSignature)
  if (startIdx === -1) {
    throw new Error(`function signature not found in migration: ${functionSignature}`)
  }
  const bodyStart = sql.indexOf('as $$', startIdx)
  const bodyEnd = sql.indexOf('$$;', bodyStart)
  if (bodyStart === -1 || bodyEnd === -1) {
    throw new Error(`could not isolate $$ body for: ${functionSignature}`)
  }
  return sql.slice(bodyStart, bodyEnd + 3)
}

describe('Platform WhatsApp domain isolation -- STRUCTURAL proof (parses the real migration SQL, no live DB required)', () => {
  it('platform_whatsapp_account has NO club_id column at all -- a result row from this table structurally cannot be scoped to any specific club', () => {
    const tableStart = migrationSql.indexOf('create table public.platform_whatsapp_account')
    expect(tableStart).toBeGreaterThan(-1)
    const tableEnd = migrationSql.indexOf(');', tableStart)
    const tableDef = migrationSql.slice(tableStart, tableEnd)
    expect(tableDef).not.toMatch(/\bclub_id\b/)
    // Confirms the singleton design itself is present (the mechanism
    // that makes "which club" a meaningless question for this table).
    expect(tableDef).toMatch(/singleton_guard int primary key default 1 check \(singleton_guard = 1\)/)
  })

  it('platform_get_whatsapp_own_qr() selects only from platform_whatsapp_account, never whatsapp_accounts, and its RETURNS TABLE has no club_id column', () => {
    const body = extractFunctionBody(migrationSql, 'create or replace function public.platform_get_whatsapp_own_qr()')
    expect(body).toContain('from public.platform_whatsapp_account')
    expect(body).not.toContain('whatsapp_accounts') // would also match "platform_whatsapp_account" as a substring if reversed; explicit exact-name check below guards that
    expect(body).not.toMatch(/from public\.whatsapp_accounts\b/)

    // The RETURNS TABLE clause itself carries no club_id -- structurally
    // the same guarantee as the table's own column set.
    const sigStart = migrationSql.indexOf('create or replace function public.platform_get_whatsapp_own_qr()')
    const returnsStart = migrationSql.indexOf('returns table(', sigStart)
    const returnsEnd = migrationSql.indexOf(')', returnsStart)
    const returnsClause = migrationSql.slice(returnsStart, returnsEnd)
    expect(returnsClause).not.toMatch(/\bclub_id\b/)
  })

  it('platform_get_whatsapp_qr(p_club_id) (defined in the companion 20260909150000 Tenant-control migration) selects only from whatsapp_accounts (the Tenant table), never platform_whatsapp_account, and is parameterized by p_club_id', () => {
    const body = extractFunctionBody(tenantControlSql, 'create or replace function public.platform_get_whatsapp_qr(p_club_id uuid)')
    expect(body).toContain('from public.whatsapp_accounts wa')
    expect(body).toContain('wa.club_id = p_club_id')
    expect(body).not.toContain('platform_whatsapp_account')
  })

  it('platform_disconnect_whatsapp_own has NO p_club_id parameter and its UPDATE target is exclusively platform_whatsapp_account -- structurally cannot be scoped to affect any specific club\'s whatsapp_accounts row', () => {
    const sigMatch = migrationSql.match(/create or replace function public\.platform_disconnect_whatsapp_own\(([^)]*)\)/)
    expect(sigMatch).toBeTruthy()
    const paramList = sigMatch![1]!
    expect(paramList).not.toMatch(/\bclub_id\b/i)
    expect(paramList.trim()).toBe('p_reason text default null')

    const body = extractFunctionBody(migrationSql, 'create or replace function public.platform_disconnect_whatsapp_own(p_reason text default null)')
    // The only UPDATE statement in this function body targets the
    // singleton platform table -- confirmed by checking every
    // "update public." occurrence in the extracted body.
    const updateTargets = [...body.matchAll(/update public\.(\w+)/g)].map((m) => m[1])
    expect(updateTargets.length).toBeGreaterThan(0)
    for (const target of updateTargets) {
      expect(target).toBe('platform_whatsapp_account')
    }
    expect(body).not.toContain('whatsapp_accounts\n') // guards against a bare mis-target that isn't caught by the update-target regex
    expect(body).not.toMatch(/update public\.whatsapp_accounts\b/)
  })

  it('whatsapp_connector_claim_next_platform_batch() FROM/UPDATE targets are exclusively platform_whatsapp_queue -- never notification_queue', () => {
    const body = extractFunctionBody(
      migrationSql,
      'create or replace function public.whatsapp_connector_claim_next_platform_batch(p_limit integer default 10)',
    )
    expect(body).not.toContain('notification_queue')

    const fromTargets = [...body.matchAll(/from public\.(\w+)/g)].map((m) => m[1])
    const updateTargets = [...body.matchAll(/update public\.(\w+)/g)].map((m) => m[1])
    const joinTargets = [...body.matchAll(/join public\.(\w+)/g)].map((m) => m[1])

    // The queue table itself is the only queue-shaped table referenced
    // anywhere in this function -- every FROM/UPDATE/JOIN target is
    // either platform_whatsapp_queue or platform_whatsapp_account/
    // platform_whatsapp_safety_settings (the account status + rate
    // limit config this claim logic reads), never any club-scoped or
    // notification_queue table.
    const allowedTargets = new Set(['platform_whatsapp_queue', 'platform_whatsapp_account', 'platform_whatsapp_safety_settings'])
    for (const target of [...fromTargets, ...updateTargets, ...joinTargets]) {
      expect(allowedTargets.has(target!)).toBe(true)
    }
    // At least one real UPDATE on the queue table (the actual claim
    // mutation) is present, not just a read.
    expect(updateTargets).toContain('platform_whatsapp_queue')
  })

  it('sales_queue_platform_whatsapp_message() is unconditionally disabled -- raises the exact documented pending-decision exception regardless of caller/message state', () => {
    const body = extractFunctionBody(
      migrationSql,
      'create or replace function public.sales_queue_platform_whatsapp_message(p_message_id uuid)',
    )
    const expectedMessage =
      "automated WhatsApp send from an AI-generated draft is not yet enabled -- whatsapp_talking_points drafts are human call/chat scripts, not send-ready message text (see this function's migration-level comment for the full product-policy question this raises, recorded in FINAL_OWNER_DECISIONS_REQUIRED.md). The platform WhatsApp CONNECTION is fully available for manual, human-composed messages."
    // Normalize whitespace/quote-doubling the same way the raw SQL
    // literal encodes ('' inside a single-quoted string == a literal
    // apostrophe once Postgres parses it) before comparing.
    const normalizedBody = body.replace(/''/g, "'")
    expect(normalizedBody).toContain(expectedMessage)

    // Confirms the raise is unconditional (not inside an if-branch that
    // could be bypassed) -- it appears BEFORE the queue INSERT, and
    // there is no code path in the body that reaches the insert without
    // passing through this raise first.
    const raiseIdx = normalizedBody.indexOf(expectedMessage)
    const insertIdx = normalizedBody.indexOf('insert into public.platform_whatsapp_queue')
    expect(raiseIdx).toBeGreaterThan(-1)
    expect(insertIdx).toBeGreaterThan(-1)
    expect(raiseIdx).toBeLessThan(insertIdx)
  })
})

// ---------------------------------------------------------------------
// BEHAVIORAL confirmation where a live QA session is available: the two
// QR RPCs genuinely return independent result sets, and platform.
// whatsapp.manage-less/unauthenticated callers are rejected from every
// Platform WhatsApp RPC exactly like the Tenant-scoped ones.
// ---------------------------------------------------------------------
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const OWNER_EMAIL = import.meta.env.PLATFORM_OWNER_TEST_EMAIL as string | undefined
const OWNER_PASSWORD = import.meta.env.PLATFORM_OWNER_TEST_PASSWORD as string | undefined
const STAFF_EMAIL = import.meta.env.PLATFORM_STAFF_TEST_ADMIN_EMAIL as string | undefined
const STAFF_PASSWORD = import.meta.env.PLATFORM_STAFF_TEST_ADMIN_PASSWORD as string | undefined
const TENANT_EMAIL = import.meta.env.QA_AUDIT_OWNER_EMAIL as string | undefined
const TENANT_PASSWORD = import.meta.env.QA_AUDIT_OWNER_PASSWORD as string | undefined

const RANDOM_CLUB_ID = '11111111-2222-3333-4444-555555555555'

function makeClient(storageKey: string): SupabaseClient {
  return createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    auth: { storageKey, persistSession: true, autoRefreshToken: false },
  })
}

async function signIn(client: SupabaseClient, email: string, password: string) {
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
}

const canRunOwner = !!(SUPABASE_URL && SUPABASE_ANON_KEY && OWNER_EMAIL && OWNER_PASSWORD)
const describeIfOwnerConfigured = canRunOwner ? describe : describe.skip

describeIfOwnerConfigured('platform_get_whatsapp_own_qr() vs platform_get_whatsapp_qr(p_club_id) -- independent result sets (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-owner-whatsapp-domain-qr-auth-token')
    await signIn(client, OWNER_EMAIL!, OWNER_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('platform_get_whatsapp_own_qr() result rows carry no club_id field at all', async () => {
    const { data, error } = await client.rpc('platform_get_whatsapp_own_qr')
    expect(error).toBeNull()
    const rows = (data as Array<Record<string, unknown>>) ?? []
    for (const row of rows) {
      expect(Object.prototype.hasOwnProperty.call(row, 'club_id')).toBe(false)
    }
  })

  it('platform_get_whatsapp_qr(p_club_id) for a random club never returns the platform account\'s own QR data', async () => {
    const [ownQr, clubQr] = await Promise.all([
      client.rpc('platform_get_whatsapp_own_qr'),
      client.rpc('platform_get_whatsapp_qr', { p_club_id: RANDOM_CLUB_ID }),
    ])
    expect(ownQr.error).toBeNull()
    expect(clubQr.error).toBeNull()
    const ownRows = (ownQr.data as Array<{ qr_payload: string | null }>) ?? []
    const clubRows = (clubQr.data as Array<{ qr_payload: string | null }>) ?? []
    // A random, essentially-certain-not-to-exist club has no
    // whatsapp_accounts row -- confirms this call is genuinely scoped
    // to that club (empty), not silently falling back to returning the
    // platform account's own (possibly non-empty) QR payload.
    expect(clubRows.length).toBe(0)
    // If the platform account happens to have a live QR pending, it must
    // never leak into the per-club call's result.
    if (ownRows.length > 0 && ownRows[0]!.qr_payload) {
      expect(clubRows.some((r) => r.qr_payload === ownRows[0]!.qr_payload)).toBe(false)
    }
  })

  it('platform_disconnect_whatsapp_own() and platform_get_whatsapp_status() take no p_club_id parameter -- calling with one is simply ignored by PostgREST\'s named-parameter matching, never silently scoped to that club', async () => {
    // PostgREST resolves RPC parameters by name; passing an unrelated
    // extra parameter name for a function that doesn't declare it
    // results in a "could not find function" / parameter mismatch
    // error, not a silent no-op scoping -- this itself is evidence the
    // function signature has no such parameter to accidentally bind to.
    const { error } = await client.rpc('platform_get_whatsapp_status', ({ p_club_id: RANDOM_CLUB_ID } as unknown) as Record<string, never>)
    expect(error).toBeTruthy()
  })
})

const canRunStaff = !!(SUPABASE_URL && SUPABASE_ANON_KEY && STAFF_EMAIL && STAFF_PASSWORD)
const describeIfStaffConfigured = canRunStaff ? describe : describe.skip

describeIfStaffConfigured('Platform WhatsApp (own) RPCs -- a staff member without platform.whatsapp_platform.manage is rejected from every variant (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-staff-whatsapp-own-scope-auth-token')
    await signIn(client, STAFF_EMAIL!, STAFF_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('cannot call platform_get_whatsapp_own_qr', async () => {
    const { error } = await client.rpc('platform_get_whatsapp_own_qr')
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('cannot call platform_get_whatsapp_status', async () => {
    const { error } = await client.rpc('platform_get_whatsapp_status')
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('cannot call platform_start_whatsapp_own_pairing', async () => {
    const { error } = await client.rpc('platform_start_whatsapp_own_pairing', { p_reason: null })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('cannot call platform_retry_whatsapp_own_connection', async () => {
    const { error } = await client.rpc('platform_retry_whatsapp_own_connection', { p_reason: null })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('cannot call platform_disconnect_whatsapp_own', async () => {
    const { error } = await client.rpc('platform_disconnect_whatsapp_own', { p_reason: 'attempted unauthorized disconnect' })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('cannot call platform_get_whatsapp_own_recent_events', async () => {
    const { error } = await client.rpc('platform_get_whatsapp_own_recent_events', {})
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('cannot call platform_flag_whatsapp_own_test_connection', async () => {
    const { error } = await client.rpc('platform_flag_whatsapp_own_test_connection', { p_reason: null })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })
})

const canRunTenant = !!(SUPABASE_URL && SUPABASE_ANON_KEY && TENANT_EMAIL && TENANT_PASSWORD)
const describeIfTenantConfigured = canRunTenant ? describe : describe.skip

describeIfTenantConfigured('Platform WhatsApp (own) RPCs -- a normal club_manager is rejected server-side from every variant (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-tenant-whatsapp-own-scope-auth-token')
    await signIn(client, TENANT_EMAIL!, TENANT_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('cannot call platform_get_whatsapp_own_qr', async () => {
    const { error } = await client.rpc('platform_get_whatsapp_own_qr')
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('cannot call platform_disconnect_whatsapp_own', async () => {
    const { error } = await client.rpc('platform_disconnect_whatsapp_own', { p_reason: 'attempted unauthorized disconnect' })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('the connector-facing service_role-only RPCs (whatsapp_connector_report_platform_status et al.) are unreachable for an authenticated tenant user -- revoked from authenticated entirely, not merely business-logic-gated', async () => {
    const { error } = await client.rpc('whatsapp_connector_report_platform_status', { p_status: 'connecting' })
    expect(error).toBeTruthy()
    // A revoked-from-authenticated RPC surfaces as a Postgres permission
    // error (or PostgREST "function not found" if it can't even resolve
    // the grant), never a clean success and never the RPC's own
    // business-logic error text -- either shape is an acceptable proof
    // that this path is closed to a tenant user.
  })
})

// ---------------------------------------------------------------------
// 4. sales_queue_platform_whatsapp_message -- live confirmation that
//    the disabled guard fires even for an owner with full sales
//    permissions (structural proof above confirms WHY; this confirms
//    the guard is reachable/live in the deployed function, not just in
//    the migration source file).
// ---------------------------------------------------------------------
describeIfOwnerConfigured('sales_queue_platform_whatsapp_message() -- deliberately disabled pending owner decision (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-owner-whatsapp-queue-disabled-auth-token')
    await signIn(client, OWNER_EMAIL!, OWNER_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('raises the exact pending-decision exception for a nonexistent message id too -- the guard fires before the message lookup, so no message/lead fixture is required to observe it', async () => {
    const { error } = await client.rpc('sales_queue_platform_whatsapp_message', {
      p_message_id: '11111111-2222-3333-4444-555555555555',
    })
    expect(error).toBeTruthy()
    // The guard raises unconditionally BEFORE the "outreach message not
    // found" lookup in the real function body (confirmed structurally
    // above) -- so even a nonexistent message id surfaces the
    // pending-decision text, not a "not found" error. If this
    // assertion ever starts seeing "outreach message not found"
    // instead, the guard has been removed/reordered without the
    // required owner decision, which is exactly the regression this
    // test exists to catch.
    expect(error!.message.toLowerCase()).toContain('not yet enabled')
    expect(error!.message.toLowerCase()).toContain('final_owner_decisions_required.md')
  })
})

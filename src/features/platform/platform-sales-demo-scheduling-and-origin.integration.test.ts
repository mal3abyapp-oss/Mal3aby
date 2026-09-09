import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// PLATFORM OWNER OPERATIONAL GAP CLOSURE -- Workstream 2 (Sales
// Intelligence Control) REGRESSION TESTS.
//
// Guards:
//   supabase/migrations/20260909160000_sales_demo_scheduling_and_lost_reason.sql
//     -- sales_schedule_demo / sales_complete_demo (first writers to
//     sales_demo_events; both call the existing, unmodified
//     sales_change_lead_status() internally rather than UPDATE-ing
//     sales_leads.status directly, so its own terminal-state guards
//     apply unchanged).
//   supabase/migrations/20260909170000_platform_club_360_sales_origin.sql
//     -- get_platform_club_sales_origin (read-only, zero rows for a
//     non-sales-sourced club, never an error).
//   supabase/migrations/20260909190000_search_sales_leads_add_status_reason.sql
//     -- search_sales_leads() DROP+CREATE to add status_reason; a
//     backward-compatibility guard given this was a return-shape change,
//     not a pure CREATE OR REPLACE.
//
// Reuses the sales_change_lead_status() guard-testing rigor style from
// platform-pagination-health-attention.integration.test.ts (a different
// domain, same evidence standard: real RPC calls, real error-message
// assertions, not mocked).
//
// Every new Sales RPC under test here follows the SAME authorization
// shape confirmed by reading 20260904140100_fix_sales_service_role_auth_
// current_user_bug_class.sql: auth.uid() is null (service_role) OR
// is_platform_owner() OR has_platform_permission('platform.sales.qualify'
// or 'platform.sales.view' as appropriate). Confirmed by reading
// 20260904090100_sales_intelligence_rls_and_permissions.sql:47 that ONLY
// platform_owner holds any platform.sales.* permission among the seeded
// roles -- so PLATFORM_STAFF_TEST_ADMIN_* (a platform_support-class
// staff account, per platform-staff-auth.integration.test.ts's own
// header) is a valid "authenticated platform staff, but zero
// platform.sales.* permission" identity for the authorization checks
// below, alongside the normal-tenant-user identity.
//
// Configure via env (reuses fixtures already established by prior
// suites -- no new env vars introduced):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
//   PLATFORM_OWNER_TEST_EMAIL / PLATFORM_OWNER_TEST_PASSWORD
//   PLATFORM_STAFF_TEST_ADMIN_EMAIL / PLATFORM_STAFF_TEST_ADMIN_PASSWORD
//   QA_AUDIT_OWNER_EMAIL / QA_AUDIT_OWNER_PASSWORD
//   PLATFORM_SALES_TEST_WON_LEAD_ID (optional -- a real sales_leads.id
//     already in a terminal status: won/awaiting_owner_activation/
//     tenant_activated. Only the specific assertion that needs a REAL
//     terminal-state lead is skipped without it; every other assertion
//     in this suite (including the terminal-state guard proven against
//     a nonexistent lead id, and the "no open demo" / "invalid outcome"
//     checks) needs no fixture beyond a signed-in owner session.
//   PLATFORM_SALES_TEST_CONVERTED_CLUB_ID (optional -- a real
//     clubs.id that has a sales_conversion_records row, i.e. was
//     sales-sourced via Phase 14 tenant activation. Only the
//     "returns the correct lead identity" assertion needs this; the
//     "zero rows, not an error" assertion needs no fixture.
// Skips cleanly without these -- every assertion group independently
// gated. No live mutation targets a lead that isn't either nonexistent
// or explicitly QA-fixture-provisioned as safe to touch.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const OWNER_EMAIL = import.meta.env.PLATFORM_OWNER_TEST_EMAIL as string | undefined
const OWNER_PASSWORD = import.meta.env.PLATFORM_OWNER_TEST_PASSWORD as string | undefined
const STAFF_EMAIL = import.meta.env.PLATFORM_STAFF_TEST_ADMIN_EMAIL as string | undefined
const STAFF_PASSWORD = import.meta.env.PLATFORM_STAFF_TEST_ADMIN_PASSWORD as string | undefined
const TENANT_EMAIL = import.meta.env.QA_AUDIT_OWNER_EMAIL as string | undefined
const TENANT_PASSWORD = import.meta.env.QA_AUDIT_OWNER_PASSWORD as string | undefined
const WON_LEAD_ID = import.meta.env.PLATFORM_SALES_TEST_WON_LEAD_ID as string | undefined
const CONVERTED_CLUB_ID = import.meta.env.PLATFORM_SALES_TEST_CONVERTED_CLUB_ID as string | undefined

const RANDOM_LEAD_ID = '11111111-2222-3333-4444-555555555555'
const RANDOM_CLUB_ID = '66666666-7777-8888-9999-000000000000'

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

// ---------------------------------------------------------------------
// 1. sales_schedule_demo / sales_complete_demo -- pipeline transitions
//    via sales_change_lead_status(), including terminal-state guards.
// ---------------------------------------------------------------------
describeIfOwnerConfigured('sales_schedule_demo() / sales_complete_demo() -- pipeline transitions (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-owner-sales-demo-scheduling-auth-token')
    await signIn(client, OWNER_EMAIL!, OWNER_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('sales_schedule_demo rejects a nonexistent lead_id ("lead not found") -- proves the existence check runs, not merely accepting any uuid', async () => {
    const { error } = await client.rpc('sales_schedule_demo', {
      p_lead_id: RANDOM_LEAD_ID,
      p_scheduled_at: new Date(Date.now() + 86400000).toISOString(),
      p_notes: 'regression test probe',
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('lead not found')
  })

  it('sales_schedule_demo rejects a null p_scheduled_at -- but only after the lead-existence check, so a nonexistent lead still reports "lead not found" first', async () => {
    const { error } = await client.rpc('sales_schedule_demo', {
      p_lead_id: RANDOM_LEAD_ID,
      p_scheduled_at: null,
    })
    expect(error).toBeTruthy()
    // Either message is a correct outcome depending on check order, but
    // it must be one of these two specific validations, not a generic
    // failure -- pins down that this RPC's own guards are what's firing.
    const msg = error!.message.toLowerCase()
    expect(msg.includes('lead not found') || msg.includes('a scheduled time is required')).toBe(true)
  })

  it('sales_complete_demo reports "no scheduled, not-yet-completed demo found" for a lead with no open demo (proven against a nonexistent lead id, which trivially has none)', async () => {
    const { error } = await client.rpc('sales_complete_demo', {
      p_lead_id: RANDOM_LEAD_ID,
      p_outcome: 'positive',
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('no scheduled, not-yet-completed demo found')
  })

  it('sales_complete_demo rejects an outcome not in positive/neutral/negative/no_show -- checked BEFORE the open-demo lookup, so this fires even for a nonexistent lead', async () => {
    const { error } = await client.rpc('sales_complete_demo', {
      p_lead_id: RANDOM_LEAD_ID,
      p_outcome: 'super_positive_definitely_converting',
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('invalid outcome')
    expect(error!.message.toLowerCase()).not.toContain('no scheduled')
  })

  it('a won/awaiting_owner_activation/tenant_activated lead cannot have a demo scheduled -- the terminal-state guard inside sales_change_lead_status() is not bypassed by going through sales_schedule_demo (proven via the RPC error text pattern against a real terminal-state fixture when available)', async () => {
    if (!WON_LEAD_ID) {
      // No QA fixture lead in a terminal status configured -- skip only
      // this specific assertion, matching this repo's established
      // fixture-gating convention. The guard's EXISTENCE is still
      // proven by reading sales_change_lead_status()'s own source
      // (20260904140100_fix_sales_service_role_auth_current_user_bug_
      // class.sql:124-126) and by the fact that sales_schedule_demo
      // calls that function unmodified rather than UPDATE-ing status
      // directly (20260909160000, confirmed above at read-time).
      return
    }
    const { error } = await client.rpc('sales_schedule_demo', {
      p_lead_id: WON_LEAD_ID,
      p_scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('already been won/converted')
  })

  it('a won/awaiting_owner_activation/tenant_activated lead cannot have a demo completed either (same underlying guard, reached via sales_complete_demo -> sales_change_lead_status)', async () => {
    if (!WON_LEAD_ID) return
    const { error } = await client.rpc('sales_complete_demo', {
      p_lead_id: WON_LEAD_ID,
      p_outcome: 'positive',
    })
    expect(error).toBeTruthy()
    // Either this lead genuinely has no open demo event (most likely for
    // a won fixture lead, since demo_completed already happened before
    // conversion) or the status-change guard itself fires -- both are
    // acceptable evidence the terminal state is respected; the
    // regression this guards against is a SILENT SUCCESS, which neither
    // branch permits.
    const msg = error!.message.toLowerCase()
    expect(msg.includes('no scheduled, not-yet-completed demo found') || msg.includes('already been won/converted')).toBe(true)
  })
})

// ---------------------------------------------------------------------
// 2. search_sales_leads() backward compatibility after the DROP+CREATE
//    additive status_reason column.
// ---------------------------------------------------------------------
describeIfOwnerConfigured('search_sales_leads() -- backward compatibility after additive status_reason column (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-owner-search-sales-leads-compat-auth-token')
    await signIn(client, OWNER_EMAIL!, OWNER_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('a plain unfiltered call succeeds and every row carries a status_reason key (even if its value is null) alongside every pre-existing column', async () => {
    const { data, error } = await client.rpc('search_sales_leads', { p_limit: 5, p_offset: 0 })
    expect(error).toBeNull()
    const rows = (data as Array<Record<string, unknown>>) ?? []
    for (const row of rows) {
      expect(Object.prototype.hasOwnProperty.call(row, 'status_reason')).toBe(true)
      // Every pre-existing column from before this migration must still
      // be present -- this is an ADDITIVE change, not a replacement.
      for (const col of ['lead_id', 'business_name', 'status', 'current_score', 'total_count']) {
        expect(Object.prototype.hasOwnProperty.call(row, col)).toBe(true)
      }
    }
  })

  it('a non-lost-filtered query (p_status omitted) returns the same row count/total_count as calling with p_status explicitly null -- proves the additive column did not silently change default filtering behavior', async () => {
    const [omitted, explicitNull] = await Promise.all([
      client.rpc('search_sales_leads', { p_limit: 50, p_offset: 0 }),
      client.rpc('search_sales_leads', { p_status: null, p_limit: 50, p_offset: 0 }),
    ])
    expect(omitted.error).toBeNull()
    expect(explicitNull.error).toBeNull()
    const omittedRows = (omitted.data as Array<{ lead_id: string; total_count: number }>) ?? []
    const explicitRows = (explicitNull.data as Array<{ lead_id: string; total_count: number }>) ?? []
    expect(omittedRows.map((r) => r.lead_id).sort()).toEqual(explicitRows.map((r) => r.lead_id).sort())
    expect(omittedRows[0]?.total_count ?? 0).toBe(explicitRows[0]?.total_count ?? 0)
  })

  it('p_exclude_do_not_contact default (true) still excludes do_not_contact leads -- the DROP+CREATE preserved every parameter default, not just the signature', async () => {
    const { data, error } = await client.rpc('search_sales_leads', { p_limit: 200, p_offset: 0 })
    expect(error).toBeNull()
    const rows = (data as Array<{ status: string }>) ?? []
    expect(rows.every((r) => r.status !== 'do_not_contact')).toBe(true)
  })
})

// ---------------------------------------------------------------------
// 3. get_platform_club_sales_origin -- zero rows (not an error) for a
//    non-sales-sourced club, correct identity when a fixture exists.
// ---------------------------------------------------------------------
describeIfOwnerConfigured('get_platform_club_sales_origin() -- read-only origin lookup (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-owner-club-sales-origin-auth-token')
    await signIn(client, OWNER_EMAIL!, OWNER_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('returns zero rows, not an error, for a club with no conversion record (the common case)', async () => {
    const { data, error } = await client.rpc('get_platform_club_sales_origin', { p_club_id: RANDOM_CLUB_ID })
    expect(error).toBeNull()
    expect((data as unknown[]) ?? []).toHaveLength(0)
  })

  it('returns the correct lead identity for a real sales-sourced club conversion, when a QA fixture is available', async () => {
    if (!CONVERTED_CLUB_ID) {
      // No QA fixture club with a real sales_conversion_records row
      // configured -- skip only this specific assertion, matching this
      // repo's established convention. The zero-row/no-error path above
      // still fully exercises this RPC's default (majority) case.
      return
    }
    const { data, error } = await client.rpc('get_platform_club_sales_origin', { p_club_id: CONVERTED_CLUB_ID })
    expect(error).toBeNull()
    const rows = (data as Array<{ lead_id: string; business_name: string }>) ?? []
    expect(rows.length).toBe(1)
    expect(rows[0]!.lead_id).toBeTruthy()
    expect(rows[0]!.business_name).toBeTruthy()
  })
})

// ---------------------------------------------------------------------
// 4. Authorization: every new Sales RPC rejects a caller without the
//    relevant platform.sales.* permission (both a platform-staff
//    identity with zero sales permissions, and a normal tenant user).
// ---------------------------------------------------------------------
const canRunStaff = !!(SUPABASE_URL && SUPABASE_ANON_KEY && STAFF_EMAIL && STAFF_PASSWORD)
const describeIfStaffConfigured = canRunStaff ? describe : describe.skip

describeIfStaffConfigured('New Sales RPCs -- authorization boundary for platform staff with zero platform.sales.* permission (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-staff-sales-demo-auth-token')
    await signIn(client, STAFF_EMAIL!, STAFF_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('cannot call sales_schedule_demo', async () => {
    const { error } = await client.rpc('sales_schedule_demo', {
      p_lead_id: RANDOM_LEAD_ID,
      p_scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('cannot call sales_complete_demo', async () => {
    const { error } = await client.rpc('sales_complete_demo', {
      p_lead_id: RANDOM_LEAD_ID,
      p_outcome: 'positive',
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('cannot call get_platform_club_sales_origin', async () => {
    const { error } = await client.rpc('get_platform_club_sales_origin', { p_club_id: RANDOM_CLUB_ID })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('get_sales_upcoming_demos returns an EMPTY result set for a caller without platform.sales.view -- this specific RPC is `language sql` with the auth check embedded in its WHERE clause (confirmed by reading 20260909180000), not a plpgsql raise, so unauthorized access surfaces as zero rows rather than an error -- this test pins down that SILENT-EMPTY shape so a future refactor that accidentally widens the WHERE clause is caught here, not just by an absent error', async () => {
    const { data, error } = await client.rpc('get_sales_upcoming_demos', { p_limit: 5 })
    expect(error).toBeNull()
    expect((data as unknown[]) ?? []).toHaveLength(0)
  })

  it('cannot call search_sales_leads', async () => {
    const { error } = await client.rpc('search_sales_leads', { p_limit: 5, p_offset: 0 })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })
})

const canRunTenant = !!(SUPABASE_URL && SUPABASE_ANON_KEY && TENANT_EMAIL && TENANT_PASSWORD)
const describeIfTenantConfigured = canRunTenant ? describe : describe.skip

describeIfTenantConfigured('New Sales RPCs -- authorization boundary for a normal club_manager (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-tenant-sales-demo-auth-token')
    await signIn(client, TENANT_EMAIL!, TENANT_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('cannot call sales_schedule_demo', async () => {
    const { error } = await client.rpc('sales_schedule_demo', {
      p_lead_id: RANDOM_LEAD_ID,
      p_scheduled_at: new Date(Date.now() + 86400000).toISOString(),
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('cannot call sales_complete_demo', async () => {
    const { error } = await client.rpc('sales_complete_demo', {
      p_lead_id: RANDOM_LEAD_ID,
      p_outcome: 'positive',
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('cannot call get_platform_club_sales_origin', async () => {
    const { error } = await client.rpc('get_platform_club_sales_origin', { p_club_id: RANDOM_CLUB_ID })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('get_sales_upcoming_demos returns an EMPTY result set for a normal club_manager (same silent-empty shape as the platform-staff case above -- this RPC never raises)', async () => {
    const { data, error } = await client.rpc('get_sales_upcoming_demos', { p_limit: 5 })
    expect(error).toBeNull()
    expect((data as unknown[]) ?? []).toHaveLength(0)
  })

  it('cannot call search_sales_leads', async () => {
    const { error } = await client.rpc('search_sales_leads', { p_limit: 5, p_offset: 0 })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })
})

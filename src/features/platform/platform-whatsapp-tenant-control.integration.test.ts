import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// PLATFORM OWNER OPERATIONAL GAP CLOSURE -- Workstream 1 (Tenant WhatsApp)
// REGRESSION TESTS.
//
// Guards supabase/migrations/20260909150000_platform_owner_whatsapp_connection_control.sql:
// platform_start_whatsapp_pairing / platform_disconnect_whatsapp /
// platform_retry_whatsapp_connection -- new RPCs letting a Platform
// Owner/staff member connect/disconnect/retry ANY club's WhatsApp
// connection (not just clubs they personally own), gated on
// is_platform_owner() OR has_platform_permission('platform.whatsapp_tenant.manage')
// instead of club membership.
//
// This suite proves the correction's own stated requirement is real,
// not frontend-only: authorization is enforced SERVER-SIDE by the RPC
// itself, for ANY club_id, including a random/nonexistent one -- a
// caller lacking the permission must be rejected before the RPC ever
// reaches its "club not found" existence check, exactly like the
// reason-required tests in platform-staff-actions-reason-required.
// integration.test.ts prove the reason check runs before the
// not-found check.
//
// Identity used for "authorized staff member, but missing
// platform.whatsapp_tenant.manage specifically": PLATFORM_STAFF_TEST_ADMIN_*
// (reused from platform-staff-auth.integration.test.ts). Confirmed by
// reading supabase/migrations/20260826121055_platform_staff_roles_schema.sql:
// only the platform_owner and platform_operations roles are granted
// platform.whatsapp_tenant.manage (20260909150000 grants it to
// platform_operations alongside its existing platform.club.manage) --
// platform_support (the role that test's own header comment documents
// this fixture account as holding) is NOT one of them, so this
// identity is a genuine "authorized platform staff member, active
// session, but lacking this ONE specific permission" case -- not a
// generic unauthenticated/tenant-user rejection, which is the more
// interesting boundary the mission's correction calls out.
//
// Configure via env (reuses fixtures from platform-staff-auth.
// integration.test.ts / platform-staff-actions-reason-required.
// integration.test.ts -- no new env vars introduced):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
//   PLATFORM_STAFF_TEST_ADMIN_EMAIL / PLATFORM_STAFF_TEST_ADMIN_PASSWORD
//     (active platform_staff_memberships holder, platform_support-class
//     role -- does NOT hold platform.whatsapp_tenant.manage)
//   PLATFORM_OWNER_TEST_EMAIL / PLATFORM_OWNER_TEST_PASSWORD
//     (real platform_owner -- used only to reach past authorization and
//     prove the reason-required validation itself; no real club is
//     ever mutated, only a nonexistent/random club_id is exercised)
//   QA_AUDIT_OWNER_EMAIL / QA_AUDIT_OWNER_PASSWORD
//     (normal club_manager, zero platform access at all)
// Skips cleanly without these -- every assertion group independently
// gated so partial configuration still runs what it can. No live
// mutation of a real club's WhatsApp connection is ever attempted --
// every call in this suite targets a random/nonexistent club_id, which
// is sufficient to prove both the authorization boundary and the
// reason-validation ordering without touching real connection state.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const STAFF_EMAIL = import.meta.env.PLATFORM_STAFF_TEST_ADMIN_EMAIL as string | undefined
const STAFF_PASSWORD = import.meta.env.PLATFORM_STAFF_TEST_ADMIN_PASSWORD as string | undefined
const OWNER_EMAIL = import.meta.env.PLATFORM_OWNER_TEST_EMAIL as string | undefined
const OWNER_PASSWORD = import.meta.env.PLATFORM_OWNER_TEST_PASSWORD as string | undefined
const TENANT_EMAIL = import.meta.env.QA_AUDIT_OWNER_EMAIL as string | undefined
const TENANT_PASSWORD = import.meta.env.QA_AUDIT_OWNER_PASSWORD as string | undefined

// A structurally-valid but essentially-certain-not-to-exist club_id --
// used across every assertion here so a rejection can only be an
// authorization/validation failure, never accidentally a real mutation.
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

// ---------------------------------------------------------------------
// 1. Server-authorized, not frontend-only: a platform staff member
//    without platform.whatsapp_tenant.manage cannot call any of the three
//    mutating Tenant WhatsApp RPCs for ANY club, including one they
//    plainly do not own and one that does not even exist.
// ---------------------------------------------------------------------
const canRunStaff = !!(SUPABASE_URL && SUPABASE_ANON_KEY && STAFF_EMAIL && STAFF_PASSWORD)
const describeIfStaffConfigured = canRunStaff ? describe : describe.skip

describeIfStaffConfigured('platform_start_whatsapp_pairing / platform_disconnect_whatsapp / platform_retry_whatsapp_connection -- server-authorized, not frontend-only (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-staff-whatsapp-tenant-scope-auth-token')
    await signIn(client, STAFF_EMAIL!, STAFF_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('a staff member without platform.whatsapp_tenant.manage cannot call platform_start_whatsapp_pairing for ANY club_id', async () => {
    const { data, error } = await client.rpc('platform_start_whatsapp_pairing', {
      p_club_id: RANDOM_CLUB_ID,
      p_reason: null,
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
    expect(data).toBeNull()
  })

  it('a staff member without platform.whatsapp_tenant.manage cannot call platform_retry_whatsapp_connection for ANY club_id', async () => {
    const { data, error } = await client.rpc('platform_retry_whatsapp_connection', {
      p_club_id: RANDOM_CLUB_ID,
      p_reason: null,
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
    expect(data).toBeNull()
  })

  it('a staff member without platform.whatsapp_tenant.manage cannot call platform_disconnect_whatsapp for ANY club_id -- rejected before the reason check even runs', async () => {
    // Deliberately omits p_reason too (which would otherwise also be
    // rejected) -- the assertion is that "not authorized" is the actual
    // error, proving the authorization check runs BEFORE the reason
    // check, not merely that some rejection happens.
    const { data, error } = await client.rpc('platform_disconnect_whatsapp', {
      p_club_id: RANDOM_CLUB_ID,
      p_reason: null,
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
    expect(error!.message.toLowerCase()).not.toContain('a reason is required')
    expect(data).toBeNull()
  })

  it('the same staff member CAN call the read-only platform_get_whatsapp_qr (platform.club.view tier), confirming the rejection above is specific to platform.whatsapp_tenant.manage, not a blanket auth failure', async () => {
    const { error } = await client.rpc('platform_get_whatsapp_qr', { p_club_id: RANDOM_CLUB_ID })
    // No qr row exists for this random club, so this returns an empty
    // set, not an authorization error -- confirming this account is
    // genuinely authenticated as platform staff with platform.club.view,
    // and the whatsapp.manage rejections above are a real, narrow
    // permission gap, not a broken session.
    expect(error).toBeNull()
  })
})

// ---------------------------------------------------------------------
// 2. Unauthenticated / normal tenant user rejected from every Tenant
//    WhatsApp platform RPC (both mutating and read variants).
// ---------------------------------------------------------------------
const canRunTenant = !!(SUPABASE_URL && SUPABASE_ANON_KEY && TENANT_EMAIL && TENANT_PASSWORD)
const describeIfTenantConfigured = canRunTenant ? describe : describe.skip

describeIfTenantConfigured('Tenant WhatsApp platform RPCs -- authorization boundary for a normal club_manager (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-tenant-whatsapp-tenant-scope-auth-token')
    await signIn(client, TENANT_EMAIL!, TENANT_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('cannot call platform_start_whatsapp_pairing', async () => {
    const { error } = await client.rpc('platform_start_whatsapp_pairing', { p_club_id: RANDOM_CLUB_ID })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('cannot call platform_retry_whatsapp_connection', async () => {
    const { error } = await client.rpc('platform_retry_whatsapp_connection', { p_club_id: RANDOM_CLUB_ID })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('cannot call platform_disconnect_whatsapp', async () => {
    const { error } = await client.rpc('platform_disconnect_whatsapp', {
      p_club_id: RANDOM_CLUB_ID,
      p_reason: 'attempted unauthorized disconnect',
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('cannot call the read-only platform_get_whatsapp_qr', async () => {
    const { error } = await client.rpc('platform_get_whatsapp_qr', { p_club_id: RANDOM_CLUB_ID })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('cannot call platform_get_whatsapp_recent_events', async () => {
    const { error } = await client.rpc('platform_get_whatsapp_recent_events', { p_club_id: RANDOM_CLUB_ID })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })
})

// ---------------------------------------------------------------------
// 3. platform_disconnect_whatsapp rejects null/empty/whitespace-only
//    reason -- mirrors platform-staff-actions-reason-required.
//    integration.test.ts's exact assertion shape.
// ---------------------------------------------------------------------
const canRunOwner = !!(SUPABASE_URL && SUPABASE_ANON_KEY && OWNER_EMAIL && OWNER_PASSWORD)
const describeIfOwnerConfigured = canRunOwner ? describe : describe.skip

describeIfOwnerConfigured('platform_disconnect_whatsapp() -- p_reason enforcement (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-owner-whatsapp-disconnect-reason-auth-token')
    await signIn(client, OWNER_EMAIL!, OWNER_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('rejects a null p_reason (relies on the RPC default null) before ever reaching a club-existence check', async () => {
    const { error } = await client.rpc('platform_disconnect_whatsapp', {
      p_club_id: RANDOM_CLUB_ID,
      p_reason: null,
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('a reason is required')
  })

  it('rejects an omitted p_reason', async () => {
    const { error } = await client.rpc('platform_disconnect_whatsapp', {
      p_club_id: RANDOM_CLUB_ID,
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('a reason is required')
  })

  it('rejects an empty-string p_reason', async () => {
    const { error } = await client.rpc('platform_disconnect_whatsapp', {
      p_club_id: RANDOM_CLUB_ID,
      p_reason: '',
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('a reason is required')
  })

  it('rejects a whitespace-only p_reason', async () => {
    const { error } = await client.rpc('platform_disconnect_whatsapp', {
      p_club_id: RANDOM_CLUB_ID,
      p_reason: '   \t\n  ',
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('a reason is required')
  })

  it('a real non-empty reason clears the reason check and reaches business logic instead (nonexistent club now fails with "club not found", not "reason required")', async () => {
    const { error } = await client.rpc('platform_disconnect_whatsapp', {
      p_club_id: RANDOM_CLUB_ID,
      p_reason: 'regression test -- reason validation probe, no real club targeted',
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).not.toContain('a reason is required')
    expect(error!.message.toLowerCase()).toContain('club not found')
  })

  it('platform_start_whatsapp_pairing and platform_retry_whatsapp_connection remain reason-OPTIONAL (not destructive) -- a null/omitted reason reaches "club not found", never a reason-required rejection', async () => {
    const pairing = await client.rpc('platform_start_whatsapp_pairing', { p_club_id: RANDOM_CLUB_ID, p_reason: null })
    expect(pairing.error).toBeTruthy()
    expect(pairing.error!.message.toLowerCase()).toContain('club not found')

    const retry = await client.rpc('platform_retry_whatsapp_connection', { p_club_id: RANDOM_CLUB_ID })
    expect(retry.error).toBeTruthy()
    expect(retry.error!.message.toLowerCase()).toContain('club not found')
  })
})

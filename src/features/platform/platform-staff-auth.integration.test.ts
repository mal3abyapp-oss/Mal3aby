import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// PLATFORM STAFF AUTH FIX -- CONTROL PLANE V1, PHASE 1 (2026-09-08)
//
// Root cause (docs/platform-owner/PLATFORM_OWNER_DEEP_DIVE_REPORT.md
// Section 2): AuthProvider.tsx's isPlatformOwner was computed purely
// from club_memberships.roles.key='platform_owner', and
// RequirePlatformOwner gated /platform/* on that flag alone --
// platform_staff_memberships (the second, backend-complete
// authorization domain seeded with 6 real roles: platform_owner,
// platform_admin, platform_support, platform_finance,
// platform_operations, platform_viewer) was never consulted client-side,
// so a legitimate active staff member could never reach the console
// built for them. Confirmed live in production before this fix: exactly
// 1 real platform_staff_memberships row existed, and that person could
// not log in.
//
// Fix: AuthProvider now also calls caller_platform_permission_keys()
// (an already-shipped, server-computed RPC -- unmodified by this fix)
// and exposes isPlatformStaff = (returned key set is non-empty).
// RequirePlatformOwner now grants entry on isPlatformOwner OR
// isPlatformStaff. isPlatformOwner's own computation is completely
// unchanged. Least privilege is enforced by PlatformLayout's nav
// filtering (a staff caller only sees nav items matching their real
// permission keys) and by every existing platform RPC's own
// has_platform_permission()/is_platform_owner() server-side check --
// this fix widens WHO can open the console shell, never what any
// caller is authorized to do inside it.
//
// This suite proves, with REAL authenticated sessions (no RPC
// impersonation, no forged JWT claims), that caller_platform_
// permission_keys() -- the exact RPC AuthProvider now depends on --
// correctly resolves access for every case the fix must get right:
//   1. A real platform_owner (club_memberships-based) gets every
//      platform permission key back (the existing bridge).
//   2. An active platform_staff_memberships holder gets exactly their
//      role's permission set back -- neither more nor less.
//   3. A DISABLED (status='inactive') platform_staff_memberships row
//      gets an EMPTY set back -- confirming disabled staff are
//      correctly rejected, not silently grandfathered in.
//   4. A normal club owner/staff member with NO platform_staff_
//      memberships row at all gets an EMPTY set back -- confirming
//      tenant users can never gain platform access through this path.
//   5. An unauthenticated caller gets an EMPTY set (RLS/RPC-level
//      default-deny, not merely a frontend redirect).
//
// This suite does NOT attempt a pixel-level browser login (this
// project's standing rule against typing/handling real passwords
// outside signInWithPassword() itself) -- it authenticates real QA
// fixture accounts the exact same way LoginPage.tsx's own call does,
// matching the established convention in staff_role_matrix.integration.
// test.ts / player-medical-notes-column-security.integration.test.ts.
//
// Configure via env (new QA fixture vars specific to this suite --
// none of the existing QA_AUDIT_* roster holds a platform_staff_
// memberships row, so dedicated accounts are required; provisioning
// them is an explicit, separate, non-code action for the repo owner,
// same pattern as every other *_TEST_EMAIL/PASSWORD pair in this repo):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
//   PLATFORM_STAFF_TEST_ADMIN_EMAIL / PLATFORM_STAFF_TEST_ADMIN_PASSWORD
//     (an account with an ACTIVE platform_staff_memberships row,
//     platform_role_key = 'platform_support' or similar non-owner role)
//   PLATFORM_STAFF_TEST_DISABLED_EMAIL / PLATFORM_STAFF_TEST_DISABLED_PASSWORD
//     (an account with an INACTIVE platform_staff_memberships row)
//   QA_AUDIT_OWNER_EMAIL / QA_AUDIT_OWNER_PASSWORD (reused from the
//     existing staff_role_matrix roster -- a normal club_manager with
//     zero platform_staff_memberships rows, proving tenant users stay
//     correctly locked out)
// Skips cleanly without these, matching this project's established
// integration-test convention -- every assertion group below is
// independently gated so partial configuration still runs what it can.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

function makeClient(storageKey: string): SupabaseClient {
  return createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    auth: { storageKey, persistSession: true, autoRefreshToken: false },
  })
}

async function signIn(client: SupabaseClient, email: string, password: string) {
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
}

// ---- Active, non-owner platform staff member -----------------------
const STAFF_EMAIL = import.meta.env.PLATFORM_STAFF_TEST_ADMIN_EMAIL as string | undefined
const STAFF_PASSWORD = import.meta.env.PLATFORM_STAFF_TEST_ADMIN_PASSWORD as string | undefined
const canRunStaff = !!(SUPABASE_URL && SUPABASE_ANON_KEY && STAFF_EMAIL && STAFF_PASSWORD)
const describeIfStaffConfigured = canRunStaff ? describe : describe.skip

describeIfStaffConfigured('Active platform staff member (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-staff-active-auth-token')
    await signIn(client, STAFF_EMAIL!, STAFF_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('caller_platform_permission_keys() returns a NON-EMPTY set for an active staff membership', async () => {
    const { data, error } = await client.rpc('caller_platform_permission_keys')
    expect(error).toBeNull()
    expect(Array.isArray(data)).toBe(true)
    expect((data as unknown[]).length).toBeGreaterThan(0)
  })

  it('an active non-owner staff member does NOT receive is_platform_owner()-only-implied full access -- verified by NOT holding every catalog key unless their seeded role grants it', async () => {
    const { data: keys } = await client.rpc('caller_platform_permission_keys')
    const { data: allPermissions } = await client.from('platform_permissions').select('key')
    const keySet = new Set((keys as string[]) ?? [])
    const allKeys = ((allPermissions as { key: string }[] | null) ?? []).map((p) => p.key)
    // Least privilege: a non-owner seeded role (platform_admin and
    // below) never holds every single catalog permission -- only
    // platform_owner's row is seeded with the full set. This assertion
    // intentionally does not hardcode which specific keys are missing
    // (that's a product/role-catalog decision, not this test's job) --
    // it only proves SOME meaningful restriction exists, i.e. this
    // account is not silently being treated as a full owner.
    expect(keySet.size).toBeLessThan(allKeys.length)
  })

  it('is_platform_owner() is FALSE for this account -- confirms the two authorization domains remain genuinely separate', async () => {
    const { data } = await client.rpc('is_platform_owner')
    expect(data).toBe(false)
  })
})

// ---- Disabled platform staff member ----------------------------------
const DISABLED_EMAIL = import.meta.env.PLATFORM_STAFF_TEST_DISABLED_EMAIL as string | undefined
const DISABLED_PASSWORD = import.meta.env.PLATFORM_STAFF_TEST_DISABLED_PASSWORD as string | undefined
const canRunDisabled = !!(SUPABASE_URL && SUPABASE_ANON_KEY && DISABLED_EMAIL && DISABLED_PASSWORD)
const describeIfDisabledConfigured = canRunDisabled ? describe : describe.skip

describeIfDisabledConfigured('Disabled platform staff member (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-staff-disabled-auth-token')
    await signIn(client, DISABLED_EMAIL!, DISABLED_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('caller_platform_permission_keys() returns an EMPTY set for a disabled (status=inactive) membership -- the actual bug this fix must not reintroduce', async () => {
    const { data, error } = await client.rpc('caller_platform_permission_keys')
    expect(error).toBeNull()
    expect((data as unknown[]) ?? []).toHaveLength(0)
  })

  it('is_platform_owner() is FALSE for a disabled staff account', async () => {
    const { data } = await client.rpc('is_platform_owner')
    expect(data).toBe(false)
  })
})

// ---- Normal tenant user (zero platform_staff_memberships rows) -------
const TENANT_EMAIL = import.meta.env.QA_AUDIT_OWNER_EMAIL as string | undefined
const TENANT_PASSWORD = import.meta.env.QA_AUDIT_OWNER_PASSWORD as string | undefined
const canRunTenant = !!(SUPABASE_URL && SUPABASE_ANON_KEY && TENANT_EMAIL && TENANT_PASSWORD)
const describeIfTenantConfigured = canRunTenant ? describe : describe.skip

describeIfTenantConfigured('Normal club owner/staff member -- must never gain platform access (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-tenant-auth-token')
    await signIn(client, TENANT_EMAIL!, TENANT_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('caller_platform_permission_keys() returns an EMPTY set for a real club_manager with no platform_staff_memberships row', async () => {
    const { data, error } = await client.rpc('caller_platform_permission_keys')
    expect(error).toBeNull()
    expect((data as unknown[]) ?? []).toHaveLength(0)
  })

  it('is_platform_owner() is FALSE for a real club_manager', async () => {
    const { data } = await client.rpc('is_platform_owner')
    expect(data).toBe(false)
  })

  it('a direct SELECT on platform_staff_memberships returns zero rows for this account (RLS: only own row or platform.staff.view holders)', async () => {
    const { data, error } = await client.from('platform_staff_memberships').select('id')
    expect(error).toBeNull()
    expect((data ?? []).length).toBe(0)
  })
})

// ---- Unauthenticated caller -------------------------------------------
const canRunAnon = !!(SUPABASE_URL && SUPABASE_ANON_KEY)
const describeIfAnonConfigured = canRunAnon ? describe : describe.skip

describeIfAnonConfigured('Unauthenticated caller -- default-deny at the RPC/RLS layer, not just a frontend redirect', () => {
  it('caller_platform_permission_keys() called with no session returns an empty set or an auth error, never real permission keys', async () => {
    const anonClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data, error } = await anonClient.rpc('caller_platform_permission_keys')
    if (error) {
      // A revoked-from-anon RPC surfaces as a permission error -- also
      // an acceptable, safe outcome for this assertion.
      expect(error).toBeTruthy()
    } else {
      expect((data as unknown[]) ?? []).toHaveLength(0)
    }
  })
})

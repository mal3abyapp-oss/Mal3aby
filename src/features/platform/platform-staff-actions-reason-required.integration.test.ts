import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// PLATFORM OWNER CONTROL PLANE V1 -- PHASE 17 REGRESSION TEST.
//
// Guards the fix landed THIS SESSION in
// supabase/migrations/20260908150000_platform_staff_actions_require_reason.sql:
// set_platform_staff_role() and deactivate_platform_staff() now both
// raise a server-side exception for a null or empty/whitespace-only
// p_reason, instead of silently writing an unexplainable
// reason=NULL audit_logs row (the confirmed-live gap this migration
// closes -- see that file's own header for the full root cause: 4 real
// production audit_logs rows, action IN
// ('platform_staff.disabled','platform_staff.role_changed'), every one
// with reason=NULL).
//
// p_reason keeps `default null` in both RPCs' signatures (so the
// caller-facing error is this migration's own explicit exception
// message, not a generic not-null-constraint failure) -- omitting the
// argument entirely and passing an explicit empty/whitespace string
// must both be rejected identically. This suite proves both paths, plus
// the accept-path with a real reason.
//
// This is the MOST IMPORTANT test in this phase: it is the only
// regression guard for a fix that could otherwise be silently
// reintroduced by a future edit that widens p_reason validation, adds a
// new call path that forgets to pass a reason, or reverts the
// server-side check under the mistaken belief that the frontend's
// disabled-Save-button already covers it (it does not -- any direct RPC
// caller bypasses client-side validation entirely, which is exactly why
// this check must live server-side and be regression-tested here).
//
// Configure via env (reuses PLATFORM_STAFF_TEST_ADMIN_* from
// platform-staff-auth.integration.test.ts -- an ACTIVE
// platform_staff_memberships holder is sufficient to prove the
// server-side p_reason validation itself; it does not need to hold
// platform.staff.role.assign/platform.staff.disable, since the reason
// check in both functions runs as plain business-logic validation
// after the has_platform_permission() authorization gate -- a caller
// who fails authorization never reaches the reason check at all, so
// this suite additionally needs a genuine platform_owner account (which
// implicitly holds every platform permission) to observe the reason
// validation in isolation from an authorization rejection):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
//   PLATFORM_OWNER_TEST_EMAIL / PLATFORM_OWNER_TEST_PASSWORD
//     (a real club_memberships-based platform_owner account -- the
//     same "real platform_owner" identity class already exercised by
//     platform-staff-auth.integration.test.ts's own describeIfStaffConfigured
//     block, just not yet given a dedicated env pair there since that
//     suite only needed is_platform_owner()=true/false as a boolean
//     outcome, never an actual owner session to drive a mutating RPC)
//   PLATFORM_STAFF_TEST_TARGET_MEMBERSHIP_ID
//     (the platform_staff_memberships.id of a QA fixture staff account
//     that is safe to repeatedly reassign to the SAME role/status as
//     part of this test -- e.g. the PLATFORM_STAFF_TEST_ADMIN_* account
//     from platform-staff-auth.integration.test.ts, reassigned to its
//     own current role via set_platform_staff_role so the accept-path
//     assertion is a genuine real no-op mutation, never a destructive
//     one)
// Skips cleanly without these, matching this project's established
// integration-test convention -- each assertion group is independently
// gated so partial configuration still runs what it can.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const OWNER_EMAIL = import.meta.env.PLATFORM_OWNER_TEST_EMAIL as string | undefined
const OWNER_PASSWORD = import.meta.env.PLATFORM_OWNER_TEST_PASSWORD as string | undefined
const TARGET_MEMBERSHIP_ID = import.meta.env.PLATFORM_STAFF_TEST_TARGET_MEMBERSHIP_ID as string | undefined

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

describeIfOwnerConfigured('deactivate_platform_staff() -- p_reason enforcement (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-owner-reason-deactivate-auth-token')
    await signIn(client, OWNER_EMAIL!, OWNER_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('rejects a nonexistent membership id with a null p_reason via the reason check, not a false-negative from "not found" (reason validated before existence lookup)', async () => {
    const { error } = await client.rpc('deactivate_platform_staff', {
      p_membership_id: '00000000-0000-0000-0000-000000000000',
      p_reason: null,
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('a reason is required')
  })

  it('rejects an omitted p_reason (relies on the RPC default null)', async () => {
    const { error } = await client.rpc('deactivate_platform_staff', {
      p_membership_id: '00000000-0000-0000-0000-000000000000',
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('a reason is required')
  })

  it('rejects an empty-string p_reason', async () => {
    const { error } = await client.rpc('deactivate_platform_staff', {
      p_membership_id: '00000000-0000-0000-0000-000000000000',
      p_reason: '',
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('a reason is required')
  })

  it('rejects a whitespace-only p_reason (the exact class of "technically non-null" bypass this fix must also catch)', async () => {
    const { error } = await client.rpc('deactivate_platform_staff', {
      p_membership_id: '00000000-0000-0000-0000-000000000000',
      p_reason: '   \t\n  ',
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('a reason is required')
  })

  it('a real non-empty reason clears the reason check and reaches business logic instead (nonexistent membership now fails with "not found", not "reason required")', async () => {
    const { error } = await client.rpc('deactivate_platform_staff', {
      p_membership_id: '00000000-0000-0000-0000-000000000000',
      p_reason: 'phase-17 regression test -- reason validation probe',
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).not.toContain('a reason is required')
    expect(error!.message.toLowerCase()).toContain('platform staff member not found')
  })
})

describeIfOwnerConfigured('set_platform_staff_role() -- p_reason enforcement (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-owner-reason-role-auth-token')
    await signIn(client, OWNER_EMAIL!, OWNER_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('rejects a null p_reason before ever reaching the exactly-one-role-specified check', async () => {
    const { error } = await client.rpc('set_platform_staff_role', {
      p_membership_id: '00000000-0000-0000-0000-000000000000',
      p_platform_role_id: null,
      p_platform_custom_role_id: null,
      p_reason: null,
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('a reason is required')
  })

  it('rejects an omitted p_reason (relies on the RPC default null)', async () => {
    const { error } = await client.rpc('set_platform_staff_role', {
      p_membership_id: '00000000-0000-0000-0000-000000000000',
      p_platform_role_id: '00000000-0000-0000-0000-000000000000',
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('a reason is required')
  })

  it('rejects an empty-string p_reason', async () => {
    const { error } = await client.rpc('set_platform_staff_role', {
      p_membership_id: '00000000-0000-0000-0000-000000000000',
      p_platform_role_id: '00000000-0000-0000-0000-000000000000',
      p_reason: '',
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('a reason is required')
  })

  it('rejects a whitespace-only p_reason', async () => {
    const { error } = await client.rpc('set_platform_staff_role', {
      p_membership_id: '00000000-0000-0000-0000-000000000000',
      p_platform_role_id: '00000000-0000-0000-0000-000000000000',
      p_reason: '\t \n',
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('a reason is required')
  })

  it('a real non-empty reason clears the reason check and reaches business logic instead (nonexistent membership now fails with "not found", not "reason required")', async () => {
    const { error } = await client.rpc('set_platform_staff_role', {
      p_membership_id: '00000000-0000-0000-0000-000000000000',
      p_platform_role_id: '00000000-0000-0000-0000-000000000000',
      p_reason: 'phase-17 regression test -- reason validation probe',
    })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).not.toContain('a reason is required')
    expect(error!.message.toLowerCase()).toContain('platform staff member not found')
  })
})

// ---- End-to-end accept path: a REAL reason on a REAL, safe target ----
// Separately gated on PLATFORM_STAFF_TEST_TARGET_MEMBERSHIP_ID so the
// two suites above (which only need not-found/business-logic branches
// to prove the reason gate itself, no real mutation) can run without
// requiring a QA fixture staff row that is safe to repeatedly touch.
const canRunRealMutation = canRunOwner && !!TARGET_MEMBERSHIP_ID
const describeIfRealMutationConfigured = canRunRealMutation ? describe : describe.skip

describeIfRealMutationConfigured('set_platform_staff_role() -- real non-empty reason succeeds end-to-end and is captured in the audit log (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-owner-reason-role-real-auth-token')
    await signIn(client, OWNER_EMAIL!, OWNER_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('reassigning the QA fixture staff member to its OWN current role with a real reason succeeds (no-op mutation, safe to re-run) and the reason is persisted, not silently dropped', async () => {
    const { data: before, error: beforeErr } = await client
      .from('platform_staff_memberships')
      .select('id, platform_role_id, platform_custom_role_id')
      .eq('id', TARGET_MEMBERSHIP_ID)
      .single()
    expect(beforeErr).toBeNull()
    expect(before).toBeTruthy()

    const reasonText = `phase-17 regression test -- no-op self-reassignment ${new Date().toISOString()}`
    const { error: rpcError } = await client.rpc('set_platform_staff_role', {
      p_membership_id: TARGET_MEMBERSHIP_ID,
      p_platform_role_id: before!.platform_role_id,
      p_platform_custom_role_id: before!.platform_custom_role_id,
      p_reason: reasonText,
    })
    expect(rpcError).toBeNull()

    const { data: auditRows, error: auditErr } = await client
      .from('audit_logs')
      .select('reason, created_at')
      .eq('entity_type', 'platform_staff_membership')
      .eq('entity_id', TARGET_MEMBERSHIP_ID)
      .eq('action', 'platform_staff.role_changed')
      .order('created_at', { ascending: false })
      .limit(1)
    expect(auditErr).toBeNull()
    expect((auditRows ?? []).length).toBeGreaterThan(0)
    // The regression this whole migration exists to fix: reason must
    // never be null on a freshly-written row of this action type.
    expect(auditRows![0]!.reason).toBe(reasonText)
  })
})

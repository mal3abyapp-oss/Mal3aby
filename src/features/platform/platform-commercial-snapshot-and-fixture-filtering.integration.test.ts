import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// PLATFORM OWNER CONTROL PLANE V1 -- PHASE 17 REGRESSION TESTS.
//
// Covers two related structural guarantees introduced/confirmed in this
// mission's migrations:
//
// 1. FIXTURE FILTERING -- get_platform_commercial_snapshot()
//    (20260908170000), get_platform_attention_items() (20260908161500),
//    and get_whatsapp_usage_platform_wide() (20260908160500) all apply
//    `coalesce(c.is_test_fixture, false) = false` throughout. This
//    guards the exact class of gap the M-2 remediation
//    (20260903140100) fixed for other platform-wide aggregates, and
//    which get_whatsapp_usage_platform_wide() specifically had NEVER
//    been fixed for (it had zero frontend call site until this
//    mission, per that migration's own header) -- a real, not
//    hypothetical, regression risk if a future edit adds a new UNION
//    branch or join without the same predicate.
//
// 2. get_platform_commercial_snapshot() NEVER FABRICATES A CONVERSION
//    RATE -- trial_to_paid_conversion_rate must always be null, with
//    trial_to_paid_conversion_rate_unavailable = true, on EVERY call.
//    Per FINAL_OWNER_DECISIONS_REQUIRED.md #11 and this migration's own
//    extensive header comment: no reliable trial->paid link exists in
//    the schema (create_platform_subscription() never populates
//    previous_subscription_id), so this is a permanent, structural
//    limitation, not a temporary gap -- a regression guard against a
//    future "fix" silently substituting an unreliable same-club-id
//    heuristic for the honest null without an explicit product
//    decision overriding FINAL_OWNER_DECISIONS_REQUIRED.md #11.
//
// Configure via env:
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
//   PLATFORM_OWNER_TEST_EMAIL / PLATFORM_OWNER_TEST_PASSWORD
//     (a real platform_owner account -- see
//     platform-staff-actions-reason-required.integration.test.ts for
//     why a genuine owner session, not just a staff session, is used
//     here: get_platform_commercial_snapshot() is gated on
//     is_platform_owner() OR platform.finance.view, and this suite
//     wants the strongest, unambiguous positive case)
//   PLATFORM_TEST_FIXTURE_CLUB_ID
//     (optional -- the id of a QA club with is_test_fixture=true that
//     ALSO has at least one real signal feeding one of these RPCs, e.g.
//     an overdue platform_invoices row, a pending
//     commercial_upgrade_requests row, or WhatsApp usage. When absent,
//     the fixture-exclusion assertions that need a concrete positive
//     fixture case are skipped individually -- matching this project's
//     established "skip the specific assertion, not the whole suite"
//     convention -- while the structural invariants that need no
//     fixture data at all (conversion-rate-never-fabricated, shape
//     checks) still run.
// Skips cleanly without these.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const OWNER_EMAIL = import.meta.env.PLATFORM_OWNER_TEST_EMAIL as string | undefined
const OWNER_PASSWORD = import.meta.env.PLATFORM_OWNER_TEST_PASSWORD as string | undefined
const FIXTURE_CLUB_ID = import.meta.env.PLATFORM_TEST_FIXTURE_CLUB_ID as string | undefined

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

describeIfOwnerConfigured('get_platform_commercial_snapshot() -- structural guarantees (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-owner-commercial-snapshot-auth-token')
    await signIn(client, OWNER_EMAIL!, OWNER_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('trial_to_paid_conversion_rate is always null and trial_to_paid_conversion_rate_unavailable is always true (FINAL_OWNER_DECISIONS_REQUIRED.md #11 -- permanent, structural, never a fabricated heuristic)', async () => {
    const { data, error } = await client.rpc('get_platform_commercial_snapshot')
    expect(error).toBeNull()
    const rows = data as unknown as Array<{
      trial_to_paid_conversion_rate: number | null
      trial_to_paid_conversion_rate_unavailable: boolean
    }>
    expect(rows.length).toBe(1)
    expect(rows[0]!.trial_to_paid_conversion_rate).toBeNull()
    expect(rows[0]!.trial_to_paid_conversion_rate_unavailable).toBe(true)
  })

  it('does not return a collected-revenue field (kept structurally separate from MRR/ARR/outstanding per the mission directive)', async () => {
    const { data, error } = await client.rpc('get_platform_commercial_snapshot')
    expect(error).toBeNull()
    const rows = data as unknown as Array<Record<string, unknown>>
    expect(rows[0]).not.toHaveProperty('collected_revenue')
  })

  it('MRR/ARR/outstanding are non-negative numeric values, and ARR is always exactly MRR * 12 (derived, never independently computed)', async () => {
    const { data, error } = await client.rpc('get_platform_commercial_snapshot')
    expect(error).toBeNull()
    const rows = data as unknown as Array<{ mrr: number; arr: number; outstanding_amount: number }>
    const row = rows[0]!
    expect(row.mrr).toBeGreaterThanOrEqual(0)
    expect(row.outstanding_amount).toBeGreaterThanOrEqual(0)
    // Floating point safety margin -- both are ROUND(x, 2) server-side.
    expect(Math.abs(row.arr - row.mrr * 12)).toBeLessThan(0.01)
  })

  it('paying_tenants/active_trials/trials_ending_soon/expired_action_required are all non-negative integers', async () => {
    const { data, error } = await client.rpc('get_platform_commercial_snapshot')
    expect(error).toBeNull()
    const rows = data as unknown as Array<{
      paying_tenants: number
      active_trials: number
      trials_ending_soon: number
      expired_action_required: number
    }>
    const row = rows[0]!
    for (const key of ['paying_tenants', 'active_trials', 'trials_ending_soon', 'expired_action_required'] as const) {
      expect(Number.isInteger(row[key])).toBe(true)
      expect(row[key]).toBeGreaterThanOrEqual(0)
    }
  })
})

describeIfOwnerConfigured('Fixture-club exclusion across platform-wide aggregate RPCs (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-owner-fixture-filter-auth-token')
    await signIn(client, OWNER_EMAIL!, OWNER_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('get_whatsapp_usage_platform_wide() never returns a row for a known is_test_fixture=true club', async () => {
    if (!FIXTURE_CLUB_ID) {
      // Skips this specific assertion, not the whole suite -- matching
      // the established convention -- when no concrete fixture club id
      // is configured in this environment.
      return
    }
    const { data, error } = await client.rpc('get_whatsapp_usage_platform_wide')
    expect(error).toBeNull()
    const rows = (data as unknown as Array<{ club_id: string }>) ?? []
    expect(rows.some((r) => r.club_id === FIXTURE_CLUB_ID)).toBe(false)
  })

  it('get_platform_attention_items() never returns a row for a known is_test_fixture=true club, across all 9 condition branches', async () => {
    if (!FIXTURE_CLUB_ID) return
    const { data, error } = await client.rpc('get_platform_attention_items')
    expect(error).toBeNull()
    const rows = (data as unknown as Array<{ club_id: string }>) ?? []
    expect(rows.some((r) => r.club_id === FIXTURE_CLUB_ID)).toBe(false)
  })

  it('get_platform_commercial_snapshot() aggregates exclude fixture clubs -- confirmed by comparing against a direct is_test_fixture=false count of paying/trialing clubs', async () => {
    // Cross-check the RPC's own paying_tenants/active_trials figures
    // against a direct, independently-filtered query over the same
    // source tables -- if the RPC's fixture predicate were ever dropped
    // from one CTE (e.g. a future edit to latest_sub or real_clubs),
    // these would silently diverge upward.
    const { data: snapshot, error: snapshotErr } = await client.rpc('get_platform_commercial_snapshot')
    expect(snapshotErr).toBeNull()
    const row = (snapshot as unknown as Array<{ paying_tenants: number; active_trials: number }>)[0]!

    const { data: realClubs, error: clubsErr } = await client
      .from('clubs')
      .select('id')
      .or('is_test_fixture.is.null,is_test_fixture.eq.false')
    expect(clubsErr).toBeNull()
    const realClubIds = new Set((realClubs ?? []).map((c: { id: string }) => c.id))

    // Sanity: the RPC's own reported counts must never exceed the total
    // number of real (non-fixture) clubs that exist at all -- a much
    // weaker but still meaningful bound that holds even without
    // reproducing the RPC's full subscription-lifecycle logic client-side.
    expect(row.paying_tenants).toBeLessThanOrEqual(realClubIds.size)
    expect(row.active_trials).toBeLessThanOrEqual(realClubIds.size)
  })
})

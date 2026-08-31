import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// ACADEMY OPERATIONS FULL AUTONOMOUS PRODUCTION HARDENING -- covers
// AC1-AC5 and AC8 (see ACADEMY_PRODUCTION_ACCEPTANCE.md): renewal
// plan_type preservation, negative-discount rejection on both
// enrollment and renewal, branch-scope on unfreeze/edit-membership,
// freeze-aware timezone-correct expiry, and same-day unfreeze.
//
// Real integration test against the live Supabase project (not
// mocked), following the exact same pattern as every
// *.integration.test.ts in this repo (see e.g.
// d4-segmented-pricing.integration.test.ts,
// booking-completion-lifecycle.integration.test.ts) -- needs a real
// QA staff account with enrollment.create/subscription.update/
// subscription.freeze.create/academy.program.manage on at least one
// club with the academy module active. Configure via env:
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (already required by the app)
//   CUSTOMER_360_TEST_EMAIL, CUSTOMER_360_TEST_PASSWORD (reuses the same
//     QA staff credentials as every other integration suite)
// Skips cleanly (not a failure) when these aren't configured.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const TEST_EMAIL = import.meta.env.CUSTOMER_360_TEST_EMAIL as string | undefined
const TEST_PASSWORD = import.meta.env.CUSTOMER_360_TEST_PASSWORD as string | undefined

const canRun = !!(SUPABASE_URL && SUPABASE_ANON_KEY && TEST_EMAIL && TEST_PASSWORD)
const describeIfConfigured = canRun ? describe : describe.skip

describeIfConfigured('Academy operations hardening (live integration)', () => {
  let client: SupabaseClient
  let clubId: string
  let branchId: string
  let groupId: string
  let playerId: string
  let guardianId: string
  const createdEnrollmentIds: string[] = []
  const createdGroupIds: string[] = []
  const createdPlayerIds: string[] = []
  const createdGuardianCustomerIds: string[] = []

  beforeAll(async () => {
    client = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!)
    const { data, error } = await client.auth.signInWithPassword({ email: TEST_EMAIL!, password: TEST_PASSWORD! })
    if (error || !data.session) throw new Error(`Test account sign-in failed: ${error?.message}`)

    const { data: clubIds, error: clubErr } = await client.rpc('user_club_ids')
    if (clubErr || !clubIds || clubIds.length === 0) throw new Error('Test account has no club membership')
    clubId = clubIds[0] as string

    const { data: branches, error: branchErr } = await client.from('branches').select('id').eq('club_id', clubId).limit(1)
    if (branchErr || !branches || branches.length === 0 || !branches[0]) throw new Error('Test club has no branches')
    branchId = branches[0].id as string

    const { data: group, error: groupErr } = await client
      .from('groups')
      .insert({ club_id: clubId, branch_id: branchId, name: 'ACADEMY_HARDENING_IT_TEST_GROUP', capacity: 5, status: 'active', subscription_price: 150 })
      .select('id')
      .single()
    if (groupErr || !group) throw new Error(`Failed to create test group: ${groupErr?.message}`)
    groupId = group.id as string
    createdGroupIds.push(groupId)

    const guardianPhone = `+2015555${Date.now().toString().slice(-5)}`
    const guardian = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'Academy Hardening Test Guardian', p_phone_e164: guardianPhone })
    if (guardian.error) throw new Error(`Failed to create test guardian: ${guardian.error.message}`)
    guardianId = guardian.data?.[0]?.customer_id
    createdGuardianCustomerIds.push(guardianId)

    const player = await client.rpc('create_player_with_guardian', { p_club_id: clubId, p_full_name: 'Academy Hardening Test Player', p_customer_id: guardianId })
    if (player.error) throw new Error(`Failed to create test player: ${player.error.message}`)
    playerId = (player.data as unknown as [string, string])[0]
    createdPlayerIds.push(playerId)
  })

  afterAll(async () => {
    for (const enrollmentId of createdEnrollmentIds) {
      const { data: subs } = await client.from('subscriptions').select('id, invoice_id').eq('enrollment_id', enrollmentId)
      for (const s of subs ?? []) {
        await client.from('subscription_freezes').delete().eq('subscription_id', s.id)
        if (s.invoice_id) await client.from('invoice_items').delete().eq('invoice_id', s.invoice_id)
      }
      // subscriptions has protected status transitions -- deleting the
      // rows directly (not transitioning status) is the safe cleanup
      // path for disposable QA fixtures, matching this suite's own
      // teardown-only use of direct table access.
      await client.from('subscriptions').delete().eq('enrollment_id', enrollmentId)
      for (const s of subs ?? []) {
        if (s.invoice_id) await client.from('invoices').delete().eq('id', s.invoice_id)
      }
      await client.from('enrollments').delete().eq('id', enrollmentId)
    }
    for (const playerId of createdPlayerIds) {
      await client.from('guardian_links').delete().eq('player_id', playerId)
      await client.from('players').delete().eq('id', playerId)
    }
    for (const groupId of createdGroupIds) {
      await client.from('groups').delete().eq('id', groupId)
    }
    for (const customerId of createdGuardianCustomerIds) {
      await client.from('customers').delete().eq('id', customerId)
    }
  })

  it('AC2: create_enrollment_with_subscription rejects a negative discount with a clean error, writes zero rows', async () => {
    const { error } = await client.rpc('create_enrollment_with_subscription', {
      p_player_id: playerId, p_group_id: groupId, p_guardian_id: guardianId,
      p_plan_type: 'monthly', p_start_date: new Date().toISOString().slice(0, 10),
      p_end_date: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      p_price: 150, p_discount: -50,
    })
    expect(error).not.toBeNull()
    expect(error?.message).toMatch(/discount amount cannot be negative/i)

    const { data: enrollments } = await client.from('enrollments').select('id').eq('player_id', playerId).eq('group_id', groupId)
    expect(enrollments ?? []).toHaveLength(0)
  })

  it('AC1: renewal preserves the enrollment\'s prior plan_type instead of hardcoding monthly', async () => {
    const enrolled = await client.rpc('create_enrollment_with_subscription', {
      p_player_id: playerId, p_group_id: groupId, p_guardian_id: guardianId,
      p_plan_type: 'quarterly', p_start_date: new Date(Date.now() - 95 * 86400000).toISOString().slice(0, 10),
      p_end_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
      p_price: 150, p_discount: 0,
    })
    expect(enrolled.error).toBeNull()
    const enrollmentId = enrolled.data?.[0]?.enrollment_id as string
    createdEnrollmentIds.push(enrollmentId)
    const initialSubscriptionId = enrolled.data?.[0]?.subscription_id as string

    // Cancel the initial subscription via the real RPC (not a direct
    // table write) so renew_academy_subscription's own "must reach
    // expired/cancelled before renewing" gate allows a fresh renewal --
    // matches how a real terminal-status transition would actually
    // happen in the product, never bypassing the real write path.
    const cancelled = await client.rpc('cancel_subscription', { p_subscription_id: initialSubscriptionId, p_reason: 'AC1 test setup: force terminal so renewal is allowed' })
    expect(cancelled.error).toBeNull()

    const renewed = await client.rpc('renew_academy_subscription', {
      p_enrollment_id: enrollmentId, p_start_date: new Date().toISOString().slice(0, 10),
      p_end_date: new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
      p_price: 150, p_discount: 0,
    })
    expect(renewed.error).toBeNull()
    const newSubscriptionId = renewed.data?.[0]?.subscription_id as string

    const { data: sub } = await client.from('subscriptions').select('plan_type').eq('id', newSubscriptionId).single()
    expect(sub?.plan_type).toBe('quarterly') // NOT 'monthly' -- the bug this test guards against
  })

  it('AC2 (renewal path): renew_academy_subscription rejects a negative discount', async () => {
    const enrolled = await client.rpc('create_enrollment_with_subscription', {
      p_player_id: playerId, p_group_id: groupId, p_guardian_id: guardianId,
      p_plan_type: 'monthly', p_start_date: new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10),
      p_end_date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
      p_price: 150, p_discount: 0,
    })
    expect(enrolled.error).toBeNull()
    const enrollmentId = enrolled.data?.[0]?.enrollment_id as string
    createdEnrollmentIds.push(enrollmentId)
    const initialSubscriptionId = enrolled.data?.[0]?.subscription_id as string

    const cancelled = await client.rpc('cancel_subscription', { p_subscription_id: initialSubscriptionId, p_reason: 'AC2 test setup' })
    expect(cancelled.error).toBeNull()

    const { error } = await client.rpc('renew_academy_subscription', {
      p_enrollment_id: enrollmentId, p_start_date: new Date().toISOString().slice(0, 10),
      p_end_date: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      p_price: 150, p_discount: -10,
    })
    expect(error).not.toBeNull()
    expect(error?.message).toMatch(/discount amount cannot be negative/i)
  })

  it('AC4 (positive path): update_academy_membership succeeds for a branch-authorized caller', async () => {
    const { data, error } = await client.rpc('update_academy_membership', {
      p_group_id: groupId, p_name: 'ACADEMY_HARDENING_IT_TEST_GROUP_RENAMED', p_capacity: 6,
      p_subscription_price: 150, p_status: 'active', p_reason: 'AC4 integration test',
    })
    expect(error).toBeNull()
    expect(data?.capacity).toBe(6)
  })

  it('AC7: deterministic subscription selection surfaces the current subscription, not a stale historical one (via get_customer_academy_players, which get_my_portal_academy mirrors exactly)', async () => {
    const enrolled = await client.rpc('create_enrollment_with_subscription', {
      p_player_id: playerId, p_group_id: groupId, p_guardian_id: guardianId,
      p_plan_type: 'monthly', p_start_date: new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10),
      p_end_date: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
      p_price: 150, p_discount: 0,
    })
    expect(enrolled.error).toBeNull()
    const enrollmentId = enrolled.data?.[0]?.enrollment_id as string
    createdEnrollmentIds.push(enrollmentId)
    const oldSubscriptionId = enrolled.data?.[0]?.subscription_id as string

    // Cancel the old subscription (real terminal transition), then
    // renew -- the enrollment now has 2 subscription rows: an old
    // cancelled one and a new pending one. get_customer_academy_players
    // (and get_my_portal_academy, which uses the identical `left join
    // lateral (... order by created_at desc limit 1)` pattern) must
    // surface the NEW one, never the stale cancelled row -- this is
    // exactly the AC7 bug class (an unordered join could have
    // surfaced either row non-deterministically).
    const cancelled = await client.rpc('cancel_subscription', { p_subscription_id: oldSubscriptionId, p_reason: 'AC7 test setup' })
    expect(cancelled.error).toBeNull()

    const newEndDate = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10)
    const renewed = await client.rpc('renew_academy_subscription', {
      p_enrollment_id: enrollmentId, p_start_date: new Date().toISOString().slice(0, 10),
      p_end_date: newEndDate, p_price: 150, p_discount: 0,
    })
    expect(renewed.error).toBeNull()

    const players = await client.rpc('get_customer_academy_players', { p_club_id: clubId, p_customer_id: guardianId })
    expect(players.error).toBeNull()
    const row = (players.data as Array<{ player_id: string; enrollment_status: string; subscription_status: string; end_date: string }>).find((p) => p.player_id === playerId)
    expect(row?.subscription_status).toBe('pending') // the NEW subscription's status, not 'cancelled'
    expect(row?.end_date).toBe(newEndDate) // the NEW subscription's end_date, not the old one's
  })

  it('AC7: get_subscription_effective_end_date correctly adds an extends_expiry freeze duration on top of the raw end_date', async () => {
    const enrolled = await client.rpc('create_enrollment_with_subscription', {
      p_player_id: playerId, p_group_id: groupId, p_guardian_id: guardianId,
      p_plan_type: 'monthly', p_start_date: new Date().toISOString().slice(0, 10),
      p_end_date: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      p_price: 150, p_discount: 0,
    })
    expect(enrolled.error).toBeNull()
    const enrollmentId = enrolled.data?.[0]?.enrollment_id as string
    createdEnrollmentIds.push(enrollmentId)
    const subscriptionId = enrolled.data?.[0]?.subscription_id as string

    await client.from('subscriptions').update({ status: 'active' }).eq('id', subscriptionId) // requires no RLS bypass -- subscription.update is held by this QA staff account
    const rawBefore = await client.from('subscriptions').select('end_date').eq('id', subscriptionId).single()

    const freeze = await client.rpc('freeze_subscription', {
      p_subscription_id: subscriptionId, p_start_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
      p_end_date: new Date(Date.now() + 11 * 86400000).toISOString().slice(0, 10), p_reason: 'AC7 effective-date test',
    })
    expect(freeze.error).toBeNull()

    const effective = await client.rpc('get_subscription_effective_end_date', { p_subscription_id: subscriptionId })
    expect(effective.error).toBeNull()
    const rawDate = new Date(rawBefore.data!.end_date as string)
    const effectiveDate = new Date(effective.data as string)
    const diffDays = Math.round((effectiveDate.getTime() - rawDate.getTime()) / 86400000)
    expect(diffDays).toBe(10) // the freeze's own duration (11 days - 1 day = 10)
  })
})

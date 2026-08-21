import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Academy Player/Guardian/Customer integrity closure. Root cause: no
// dedicated player create/edit RPC existed (players + guardian_links
// were two independent client-side .insert() calls with no
// transaction), no RPC to link/unlink a guardian or atomically change
// the primary guardian, and subscriptions.price/enrollment_id/
// plan_type/start_date were mutable via a direct UPDATE with zero
// server-side protection. Fixed by create_player_with_guardian (the
// transactional replacement), link_guardian_to_player,
// unlink_guardian_from_player, set_primary_guardian,
// get_player_360_summary, and a new BEFORE UPDATE immutability trigger
// on subscriptions.
//
// Real integration test against the live Supabase project (not
// mocked), following the same pattern as customer360/staff360/
// sp001-cancelled-booking's own integration suites -- needs a real QA
// staff account with player.create/player.update/customer.update on at
// least one club. Configure via env:
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (already required by the app)
//   CUSTOMER_360_TEST_EMAIL, CUSTOMER_360_TEST_PASSWORD (reuses the same
//     QA staff credentials as the other integration suites)
// Skips cleanly (not a failure) when these aren't configured.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const TEST_EMAIL = import.meta.env.CUSTOMER_360_TEST_EMAIL as string | undefined
const TEST_PASSWORD = import.meta.env.CUSTOMER_360_TEST_PASSWORD as string | undefined

const canRun = !!(SUPABASE_URL && SUPABASE_ANON_KEY && TEST_EMAIL && TEST_PASSWORD)
const describeIfConfigured = canRun ? describe : describe.skip

describeIfConfigured('Academy Player/Guardian/Customer invariants (live integration)', () => {
  let client: SupabaseClient
  let clubId: string
  const createdPlayerIds: string[] = []
  const createdCustomerIds: string[] = []

  beforeAll(async () => {
    client = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!)
    const { data, error } = await client.auth.signInWithPassword({ email: TEST_EMAIL!, password: TEST_PASSWORD! })
    if (error || !data.session) throw new Error(`Test account sign-in failed: ${error?.message}`)

    const { data: clubIds, error: clubErr } = await client.rpc('user_club_ids')
    if (clubErr || !clubIds || clubIds.length === 0) throw new Error('Test account has no club membership')
    clubId = clubIds[0] as string
  })

  afterAll(async () => {
    // Best-effort cleanup, using reversal/removal RPCs and direct
    // deletes only for rows this suite itself created -- never touches
    // pre-existing QA fixtures or real financial history.
    for (const playerId of createdPlayerIds) {
      await client.from('guardian_links').delete().eq('player_id', playerId)
      await client.from('players').delete().eq('id', playerId)
    }
    for (const customerId of createdCustomerIds) {
      await client.from('customers').delete().eq('id', customerId)
    }
  })

  it('Guardian = Customer: create_player_with_guardian creates a player and links an existing customer in one transaction', async () => {
    const phone = `+2015561${Date.now().toString().slice(-5)}`
    const guardian = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'IT Guardian A', p_phone_e164: phone })
    expect(guardian.error).toBeNull()
    const guardianId = guardian.data?.[0]?.customer_id as string
    createdCustomerIds.push(guardianId)

    const result = await client.rpc('create_player_with_guardian', {
      p_club_id: clubId, p_full_name: 'IT Player A', p_customer_id: guardianId, p_relationship: 'mother', p_is_primary: true,
    })
    expect(result.error).toBeNull()
    const playerId = result.data?.[0]?.player_id as string
    const linkId = result.data?.[0]?.guardian_link_id as string
    expect(playerId).toBeTruthy()
    expect(linkId).toBeTruthy()
    createdPlayerIds.push(playerId)

    const { data: link, error: linkErr } = await client.from('guardian_links').select('customer_id, relationship, is_primary').eq('id', linkId).single()
    expect(linkErr).toBeNull()
    expect(link!.customer_id).toBe(guardianId)
    expect(link!.relationship).toBe('mother')
    expect(link!.is_primary).toBe(true)
  })

  it('Player without guardian: create_player_with_guardian accepts a null customer id', async () => {
    const result = await client.rpc('create_player_with_guardian', { p_club_id: clubId, p_full_name: 'IT Player No Guardian' })
    expect(result.error).toBeNull()
    const playerId = result.data?.[0]?.player_id as string
    expect(playerId).toBeTruthy()
    expect(result.data?.[0]?.guardian_link_id).toBeNull()
    createdPlayerIds.push(playerId)

    const { count } = await client.from('guardian_links').select('id', { count: 'exact', head: true }).eq('player_id', playerId)
    expect(count).toBe(0)
  })

  it('Multiple guardians per player + single primary invariant: link_guardian_to_player and set_primary_guardian', async () => {
    const player = await client.rpc('create_player_with_guardian', { p_club_id: clubId, p_full_name: 'IT Player Multi-Guardian' })
    const playerId = player.data?.[0]?.player_id as string
    createdPlayerIds.push(playerId)

    const phoneA = `+2015562${Date.now().toString().slice(-5)}`
    const phoneB = `+2015563${Date.now().toString().slice(-5)}`
    const guardianA = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'IT Guardian B1', p_phone_e164: phoneA })
    const guardianB = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'IT Guardian B2', p_phone_e164: phoneB })
    const guardianAId = guardianA.data?.[0]?.customer_id as string
    const guardianBId = guardianB.data?.[0]?.customer_id as string
    createdCustomerIds.push(guardianAId, guardianBId)

    const linkA = await client.rpc('link_guardian_to_player', { p_player_id: playerId, p_customer_id: guardianAId, p_relationship: 'father', p_is_primary: true })
    expect(linkA.error).toBeNull()
    const linkB = await client.rpc('link_guardian_to_player', { p_player_id: playerId, p_customer_id: guardianBId, p_relationship: 'mother', p_is_primary: false })
    expect(linkB.error).toBeNull()

    // Duplicate link (same customer + same player) must be rejected.
    const duplicate = await client.rpc('link_guardian_to_player', { p_player_id: playerId, p_customer_id: guardianAId, p_relationship: 'father', p_is_primary: false })
    expect(duplicate.error).not.toBeNull()

    // Both guardians visible, exactly one primary.
    const { data: linksBefore } = await client.from('guardian_links').select('customer_id, is_primary').eq('player_id', playerId)
    expect(linksBefore).toHaveLength(2)
    expect(linksBefore!.filter((l) => l.is_primary)).toHaveLength(1)
    expect(linksBefore!.find((l) => l.is_primary)?.customer_id).toBe(guardianAId)

    // Atomic primary swap.
    const swap = await client.rpc('set_primary_guardian', { p_player_id: playerId, p_customer_id: guardianBId })
    expect(swap.error).toBeNull()

    const { data: linksAfter } = await client.from('guardian_links').select('customer_id, is_primary').eq('player_id', playerId)
    expect(linksAfter!.filter((l) => l.is_primary)).toHaveLength(1)
    expect(linksAfter!.find((l) => l.is_primary)?.customer_id).toBe(guardianBId)
  })

  it('Player edit does not affect guardian relationships or require re-linking', async () => {
    const phone = `+2015564${Date.now().toString().slice(-5)}`
    const guardian = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'IT Guardian C', p_phone_e164: phone })
    const guardianId = guardian.data?.[0]?.customer_id as string
    createdCustomerIds.push(guardianId)

    const player = await client.rpc('create_player_with_guardian', { p_club_id: clubId, p_full_name: 'IT Player Edit Test', p_customer_id: guardianId, p_relationship: 'guardian', p_is_primary: true })
    const playerId = player.data?.[0]?.player_id as string
    createdPlayerIds.push(playerId)

    const edit = await client.rpc('update_player', { p_player_id: playerId, p_full_name: 'IT Player Edit Test (Renamed)', p_status: 'active' })
    expect(edit.error).toBeNull()

    const { data: row, error } = await client.from('players').select('full_name').eq('id', playerId).single()
    expect(error).toBeNull()
    expect(row!.full_name).toBe('IT Player Edit Test (Renamed)')

    const { count } = await client.from('guardian_links').select('id', { count: 'exact', head: true }).eq('player_id', playerId)
    expect(count).toBe(1)
  })

  it('Remove guardian relationship deletes only the relationship, never the customer or player', async () => {
    const phone = `+2015565${Date.now().toString().slice(-5)}`
    const guardian = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'IT Guardian D', p_phone_e164: phone })
    const guardianId = guardian.data?.[0]?.customer_id as string
    createdCustomerIds.push(guardianId)

    const player = await client.rpc('create_player_with_guardian', { p_club_id: clubId, p_full_name: 'IT Player Unlink Test', p_customer_id: guardianId })
    const playerId = player.data?.[0]?.player_id as string
    const linkId = player.data?.[0]?.guardian_link_id as string
    createdPlayerIds.push(playerId)

    const unlink = await client.rpc('unlink_guardian_from_player', { p_guardian_link_id: linkId })
    expect(unlink.error).toBeNull()

    const { data: link } = await client.from('guardian_links').select('id').eq('id', linkId).maybeSingle()
    expect(link).toBeNull()

    const { data: customerRow } = await client.from('customers').select('id').eq('id', guardianId).maybeSingle()
    expect(customerRow).not.toBeNull()
    const { data: playerRow } = await client.from('players').select('id').eq('id', playerId).maybeSingle()
    expect(playerRow).not.toBeNull()
  })

  it('get_player_360_summary returns a consistent, self-contained snapshot including guardians, membership, and financial state', async () => {
    const phone = `+2015566${Date.now().toString().slice(-5)}`
    const guardian = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'IT Guardian E', p_phone_e164: phone })
    const guardianId = guardian.data?.[0]?.customer_id as string
    createdCustomerIds.push(guardianId)

    const player = await client.rpc('create_player_with_guardian', { p_club_id: clubId, p_full_name: 'IT Player Summary Test', p_customer_id: guardianId, p_relationship: 'father', p_is_primary: true })
    const playerId = player.data?.[0]?.player_id as string
    createdPlayerIds.push(playerId)

    const summary = await client.rpc('get_player_360_summary', { p_club_id: clubId, p_player_id: playerId })
    expect(summary.error).toBeNull()
    const s = summary.data as { player: { full_name: string }; guardians: unknown[]; primary_guardian: { customer_id: string }; current_membership: unknown }
    expect(s.player.full_name).toBe('IT Player Summary Test')
    expect(s.guardians).toHaveLength(1)
    expect(s.primary_guardian?.customer_id).toBe(guardianId)
    // A brand-new player has no active enrollment -- must be null, not a crash.
    expect(s.current_membership).toBeNull()
  })

  it('Tenant isolation: get_player_360_summary and create_player_with_guardian reject a club the caller is not a member of', async () => {
    const foreignClubId = '00000000-0000-0000-0000-000000000000'
    const summaryResult = await client.rpc('get_player_360_summary', { p_club_id: foreignClubId, p_player_id: '00000000-0000-0000-0000-000000000001' })
    expect(summaryResult.error).not.toBeNull()

    const createResult = await client.rpc('create_player_with_guardian', { p_club_id: foreignClubId, p_full_name: 'Cross Tenant Attack Player' })
    expect(createResult.error).not.toBeNull()
  })
})

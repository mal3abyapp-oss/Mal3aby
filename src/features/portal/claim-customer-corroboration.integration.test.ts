import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// AUTH/ONBOARDING/RECOVERY ACCEPTANCE (2026-08-31) -- P0 SECURITY FIX
// regression coverage. claim_customer_self_service() previously accepted
// only (p_club_id, p_customer_id) and performed NO independent
// corroboration check of its own -- it trusted that the caller could
// only ever reach it after going through find_claimable_customer()'s
// phone-lookup step in the UI. Live-reproduced this session: a
// completely unrelated fresh auth identity, with zero knowledge of the
// target customer's phone number, successfully claimed ownership of a
// real customer record carrying 21 historical bookings/invoices purely
// by knowing/guessing its customer_id -- a genuine account/data-
// takeover vulnerability. Fixed by adding a required p_normalized_mobile
// parameter that the RPC now independently re-verifies against the
// target customer's own normalized_mobile, using the exact same match
// condition find_claimable_customer() already uses -- the RPC is now
// self-sufficient and secure regardless of caller behavior.
//
// Real integration test against the live Supabase project (not mocked),
// following the exact same pattern as every other *.integration.test.ts
// in this repo. Needs a real QA staff account with customer.create on at
// least one club (to seed a disposable QA customer with a known phone),
// and Supabase Admin API access is NOT required -- these tests create
// their own disposable auth identities directly via supabase-js
// signUp(), matching the accepted safe-QA-fixture pattern for this
// domain. Configure via env:
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (already required by the app)
//   CUSTOMER_360_TEST_EMAIL, CUSTOMER_360_TEST_PASSWORD (reuses the same
//     QA staff credentials as every other integration suite, to seed a
//     disposable QA customer via upsert_customer)
// Skips cleanly (not a failure) when these aren't configured.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const TEST_EMAIL = import.meta.env.CUSTOMER_360_TEST_EMAIL as string | undefined
const TEST_PASSWORD = import.meta.env.CUSTOMER_360_TEST_PASSWORD as string | undefined

const canRun = !!(SUPABASE_URL && SUPABASE_ANON_KEY && TEST_EMAIL && TEST_PASSWORD)
const describeIfConfigured = canRun ? describe : describe.skip

describeIfConfigured('claim_customer_self_service phone corroboration (live integration)', () => {
  let staffClient: SupabaseClient
  let clubId: string
  let targetCustomerId: string
  const targetPhone = '+201099887766'
  const targetNormalizedMobile = '1099887766'

  beforeAll(async () => {
    staffClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!)
    const { data, error } = await staffClient.auth.signInWithPassword({ email: TEST_EMAIL!, password: TEST_PASSWORD! })
    if (error || !data.session) throw new Error(`Test account sign-in failed: ${error?.message}`)

    const { data: clubIds, error: clubErr } = await staffClient.rpc('user_club_ids')
    if (clubErr || !clubIds || clubIds.length === 0) throw new Error('Test account has no club membership')
    clubId = clubIds[0] as string

    // Seed a disposable, unclaimed QA customer with a known phone --
    // this is the "historical customer" a real person would later claim.
    const upsert = await staffClient.rpc('upsert_customer', {
      p_club_id: clubId,
      p_full_name: 'QA_ClaimCorroboration_TestTarget',
      p_phone_e164: targetPhone,
      p_mobile_display: '01099887766',
    })
    if (upsert.error) throw new Error(`Failed to seed QA customer: ${upsert.error.message}`)
    targetCustomerId = (upsert.data as { customer_id: string }[])[0]!.customer_id
  })

  afterAll(async () => {
    // Reset the QA customer back to unclaimed (never hard-delete --
    // matches this whole session's established safe-QA convention) so
    // repeated test runs stay idempotent, and remove any disposable auth
    // identities this suite created.
    await staffClient.rpc('upsert_customer', {
      p_club_id: clubId,
      p_full_name: 'QA_ClaimCorroboration_TestTarget',
      p_phone_e164: targetPhone,
      p_customer_id: targetCustomerId,
    })
  })

  it('a caller with the WRONG phone number cannot claim the customer, even knowing its exact customer_id', async () => {
    const attackerEmail = `qa.claim.attacker.${Date.now()}@mal3aby-qa-fixture.test`
    const attackerClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!)
    const signUp = await attackerClient.auth.signUp({ email: attackerEmail, password: 'Qa!TestPassword123' })
    expect(signUp.error).toBeNull()

    // Attacker never calls find_claimable_customer() at all -- goes
    // straight for the claim RPC with a customer_id it has no
    // legitimate way of knowing was ever presented to it, using a
    // deliberately wrong phone number.
    const attack = await attackerClient.rpc('claim_customer_self_service', {
      p_club_id: clubId,
      p_customer_id: targetCustomerId,
      p_normalized_mobile: '1000000000',
    })
    expect(attack.error).not.toBeNull()
    expect(attack.error?.message).toContain('customer not found')

    // Confirm the customer record was NOT linked to the attacker.
    const check = await staffClient.rpc('get_customer_360_summary', { p_club_id: clubId, p_customer_id: targetCustomerId })
    expect(check.error).toBeNull()
    expect((check.data as { customer: { user_id: string | null } }).customer.user_id).toBeNull()
  })

  it('a caller with the CORRECT phone number can legitimately claim the customer', async () => {
    const legitEmail = `qa.claim.legit.${Date.now()}@mal3aby-qa-fixture.test`
    const legitClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!)
    const signUp = await legitClient.auth.signUp({ email: legitEmail, password: 'Qa!TestPassword123' })
    expect(signUp.error).toBeNull()

    const claim = await legitClient.rpc('claim_customer_self_service', {
      p_club_id: clubId,
      p_customer_id: targetCustomerId,
      p_normalized_mobile: targetNormalizedMobile,
    })
    expect(claim.error).toBeNull()
    expect(claim.data).toBe(targetCustomerId)
  })
})

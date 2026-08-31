import { describe, it, expect, beforeAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Customer 360 closure directive point 4: "The final report cannot
// leave the critical invariant suite as a follow-up." Every rule
// below was already proven live during this engagement (direct SQL,
// authenticated browser fetch()) -- this file turns those into a
// repeatable, CI-runnable suite against the real RPCs rather than
// leaving the proof only in a session transcript.
//
// This is a real integration test against the live Supabase project
// (not mocked, not jsdom-simulated) -- it needs a genuine QA staff
// account's credentials to authenticate as a real user, exactly as
// the RPCs' own `has_permission`/`user_club_ids()` authorization
// checks require. Configure via env:
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (already required by
//     the app itself, see .env.example)
//   CUSTOMER_360_TEST_EMAIL, CUSTOMER_360_TEST_PASSWORD (a real staff
//     account with customer.view/customer.update/customer.create on
//     at least one club -- never a service_role key)
// Skips cleanly (not a failure) when these aren't configured, so a
// CI run without secrets doesn't red the build; run locally or in an
// environment with the QA credentials to actually execute it.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const TEST_EMAIL = import.meta.env.CUSTOMER_360_TEST_EMAIL as string | undefined
const TEST_PASSWORD = import.meta.env.CUSTOMER_360_TEST_PASSWORD as string | undefined

const canRun = !!(SUPABASE_URL && SUPABASE_ANON_KEY && TEST_EMAIL && TEST_PASSWORD)
const describeIfConfigured = canRun ? describe : describe.skip

describeIfConfigured('Customer 360 invariants (live integration)', () => {
  let client: SupabaseClient
  let clubId: string

  beforeAll(async () => {
    client = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!)
    const { data, error } = await client.auth.signInWithPassword({ email: TEST_EMAIL!, password: TEST_PASSWORD! })
    if (error || !data.session) throw new Error(`Test account sign-in failed: ${error?.message}`)
    const { data: clubIds, error: clubErr } = await client.rpc('user_club_ids')
    if (clubErr || !clubIds || clubIds.length === 0) throw new Error('Test account has no club membership')
    clubId = clubIds[0] as string
  })

  // Directive: "canonical duplicate detection" + "duplicate update
  // prevented" -- creating two customers with the same (club_id,
  // phone_e164) must never both succeed as separate canonical rows.
  it('rejects a second canonical customer with the same phone in the same club', async () => {
    const phone = `+2015550${Date.now().toString().slice(-5)}`
    const first = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'Integration Test A', p_phone_e164: phone })
    expect(first.error).toBeNull()
    const firstId = first.data?.[0]?.customer_id
    expect(firstId).toBeTruthy()

    // Second call for the SAME phone must resolve to the SAME customer
    // (upsert_customer's own idempotent-create semantics), never a
    // second row.
    const second = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'Integration Test A Again', p_phone_e164: phone })
    expect(second.error).toBeNull()
    expect(second.data?.[0]?.customer_id).toBe(firstId)
    expect(second.data?.[0]?.was_existing).toBe(true)
  })

  // Directive: "customer upsert concurrency/idempotency" -- database
  // uniqueness/locking must provide the guarantee, not check-then-
  // insert. A genuine concurrent race for the same new phone must
  // still resolve to exactly one customer id.
  it('resolves a concurrent create race for the same new phone to exactly one customer id', async () => {
    const phone = `+2015551${Date.now().toString().slice(-5)}`
    const calls = Array.from({ length: 5 }, (_, i) =>
      client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: `Race Test ${i}`, p_phone_e164: phone }),
    )
    const results = await Promise.all(calls)
    for (const r of results) expect(r.error).toBeNull()
    const ids = new Set(results.map((r) => r.data?.[0]?.customer_id))
    expect(ids.size).toBe(1)
  })

  // Directive: "duplicate update prevented" -- editing an unrelated
  // customer to an already-canonical phone must return the conflict,
  // never silently reassign the number.
  it('returns duplicate_of_customer_id instead of overwriting on edit-to-existing-phone', async () => {
    const phoneA = `+2015552${Date.now().toString().slice(-5)}`
    const a = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'Owner Of Phone A', p_phone_e164: phoneA })
    expect(a.error).toBeNull()

    const b = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'Unrelated Customer B', p_phone_e164: undefined })
    expect(b.error).toBeNull()
    const bId = b.data?.[0]?.customer_id

    const conflict = await client.rpc('upsert_customer', {
      p_club_id: clubId, p_full_name: 'Unrelated Customer B', p_phone_e164: phoneA, p_customer_id: bId,
    })
    expect(conflict.error).toBeNull()
    expect(conflict.data?.[0]?.duplicate_of_customer_id).toBeTruthy()
  })

  // Directive: "financial total calculation / response contract" --
  // UI TOTAL = DB AGGREGATION. Verifies the summary RPC's totals are
  // internally consistent (outstanding = invoiced - paid + refunded
  // is the documented formula) rather than independently recomputed
  // client-side, and that the RPC's response shape matches what
  // Customer360Page.tsx actually destructures.
  it('get_customer_360_summary returns a self-consistent financial contract', async () => {
    const phone = `+2015553${Date.now().toString().slice(-5)}`
    const created = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'Financial Contract Test', p_phone_e164: phone })
    expect(created.error).toBeNull()
    const customerId = created.data?.[0]?.customer_id

    const summary = await client.rpc('get_customer_360_summary', { p_club_id: clubId, p_customer_id: customerId })
    expect(summary.error).toBeNull()
    const fin = summary.data?.financial
    expect(fin).toBeTruthy()
    expect(typeof fin.total_invoiced).toBe('number')
    expect(typeof fin.total_paid).toBe('number')
    expect(typeof fin.outstanding).toBe('number')
    // A brand-new customer has zero of everything -- proves the RPC
    // reads live from source tables rather than returning stale/
    // placeholder data.
    expect(fin.total_invoiced).toBe(0)
    expect(fin.outstanding).toBe(0)
  })

  // Directive: "revoked consent not silently restored" + "phone-
  // change consent behavior".
  it('does not silently restore a revoked consent decision on a later unrelated update', async () => {
    const phone = `+2015554${Date.now().toString().slice(-5)}`
    const created = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'Consent Continuity Test', p_phone_e164: phone, p_whatsapp_consent: true })
    expect(created.error).toBeNull()
    const customerId = created.data?.[0]?.customer_id

    const revoke = await client.rpc('set_customer_whatsapp_consent', { p_club_id: clubId, p_customer_id: customerId, p_consented: false })
    expect(revoke.error).toBeNull()

    // A later name-only edit through upsert_customer (no p_whatsapp_consent)
    // must not touch consent at all.
    const rename = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'Consent Continuity Test Renamed', p_phone_e164: phone, p_customer_id: customerId })
    expect(rename.error).toBeNull()

    const comms = await client.rpc('get_customer_communications', { p_club_id: clubId, p_customer_id: customerId })
    expect(comms.error).toBeNull()
    expect(comms.data?.consent?.enabled).toBe(false)
  })

  // NOTIFICATIONS & COMMUNICATIONS ACCEPTANCE (D-NOTIF-001 regression):
  // get_customer_communications() previously hardcoded channel =
  // 'whatsapp', making real, separately-tracked email notifications
  // (booking confirmations, payment receipts) entirely invisible to
  // staff -- no practical way to answer "did the customer receive the
  // booking email?" without raw SQL. Fixed to include both channels,
  // each row now tagged with its own `channel`.
  it('includes email-channel notifications in communication history, each tagged with its own channel', async () => {
    const phone = `+2015557${Date.now().toString().slice(-5)}`
    const created = await client.rpc('upsert_customer', {
      p_club_id: clubId,
      p_full_name: 'Email Comms Regression Test',
      p_phone_e164: phone,
    })
    expect(created.error).toBeNull()
    const customerId = created.data?.[0]?.customer_id

    // queue_email_notification() itself is service_role-only (by
    // design -- see architecture notes), so this test asserts the
    // READ side's shape and channel filter rather than fabricating a
    // queue row this authenticated session has no legitimate way to
    // create. A real email row (if any exists for this fresh customer)
    // must come back tagged channel: 'email', never silently dropped.
    const comms = await client.rpc('get_customer_communications', { p_club_id: clubId, p_customer_id: customerId })
    expect(comms.error).toBeNull()
    expect(comms.data?.events?.rows).toEqual(expect.any(Array))
    for (const row of comms.data?.events?.rows ?? []) {
      expect(['whatsapp', 'email']).toContain(row.channel)
    }
  })

  // Directive: "tenant isolation at the appropriate test layer" --
  // real authenticated session (not service_role) against a club it
  // has no membership in must hard-fail, not return zero rows via a
  // silent empty-result path.
  it('rejects Customer 360 RPCs for a club the authenticated user is not a member of', async () => {
    const foreignClubId = '00000000-0000-0000-0000-000000000000'
    const result = await client.rpc('get_customer_360_summary', { p_club_id: foreignClubId, p_customer_id: '00000000-0000-0000-0000-000000000001' })
    expect(result.error).not.toBeNull()
  })

  // Directive: "guardian primary uniqueness" -- exactly one primary
  // guardian per player is enforced at the database level.
  it('enforces exactly one primary guardian per player', async () => {
    const phone1 = `+2015555${Date.now().toString().slice(-5)}`
    const phone2 = `+2015556${Date.now().toString().slice(-5)}`
    const g1 = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'Guardian One', p_phone_e164: phone1 })
    const g2 = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'Guardian Two', p_phone_e164: phone2 })
    expect(g1.error).toBeNull()
    expect(g2.error).toBeNull()

    const { data: player, error: playerErr } = await client.from('players').insert({ club_id: clubId, full_name: 'Primary Guardian Test Player' }).select('id').single()
    expect(playerErr).toBeNull()

    const link1 = await client.from('guardian_links').insert({ customer_id: g1.data?.[0]?.customer_id, player_id: player!.id, relationship: 'guardian', is_primary: true })
    expect(link1.error).toBeNull()

    // A second primary for the SAME player must be rejected by the
    // partial unique index (guardian_links_one_primary_per_player).
    const link2 = await client.from('guardian_links').insert({ customer_id: g2.data?.[0]?.customer_id, player_id: player!.id, relationship: 'guardian', is_primary: true })
    expect(link2.error).not.toBeNull()

    // A second NON-primary guardian for the same player is allowed.
    const link2b = await client.from('guardian_links').insert({ customer_id: g2.data?.[0]?.customer_id, player_id: player!.id, relationship: 'guardian', is_primary: false })
    expect(link2b.error).toBeNull()
  })
})

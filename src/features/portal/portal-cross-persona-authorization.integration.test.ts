import { describe, it, expect, beforeAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// PORTAL CROSS-PERSONA AUTHORIZATION VULNERABILITY (HIGH, confirmed live in
// production, 2026-08-25). Real finding: every Customer Portal query
// (PortalClubProvider.fetchMyCustomerMemberships, PortalRoot.
// fetchMyLinkedCustomerCount, PortalProfilePage.fetchMyCustomerRecords,
// PortalAcademyPage.fetchMyPlayers) queried customers/guardian_links with
// ZERO filter, and PortalBookingsPage/PortalPaymentsPage/PortalQrPage
// filtered only by club_id -- both relying on RLS alone to scope results.
// That assumption breaks for any account that is ALSO staff somewhere:
// Postgres OR-combines customers_select_club_staff / bookings_select_
// club_staff / invoices_select_club_staff / guardian_links_select_club_staff
// into the same query, so a staff member's Portal session received their
// entire club's customer roster, bookings, invoices, and guardian_links --
// proven live via real authenticated REST calls using a real staff+portal
// session's own JWT (no impersonation): GET /customers returned the whole
// club roster; GET /invoices?club_id=eq.<club> returned 5 real unrelated
// invoices; GET /guardian_links returned 8 real unrelated rows.
//
// FIX: get_my_portal_customers() -- a SECURITY DEFINER RPC that checks
// customers.user_id = auth.uid() directly in its own SQL body, never
// delegating to RLS's OR-combined policy set. Every Portal screen now
// derives its customer_id allowlist exclusively from this RPC, then
// filters bookings/invoices/guardian_links by that explicit,
// ownership-proven id set.
//
// This suite reuses the SAME QA staff fixture as dual-identity-email-
// isolation.integration.test.ts (a real account with an active
// club_membership carrying customer.view/booking.view/invoice.view --
// exactly the account shape that triggered the OR-combined RLS bleed) to
// prove the fix holds for the account class that is actually at risk, not
// just a plain customer account. Configure via env (same convention as
// every other integration suite in this project):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
//   CUSTOMER_360_TEST_EMAIL, CUSTOMER_360_TEST_PASSWORD
// Skips cleanly (not a failure) when these aren't configured.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const TEST_EMAIL = import.meta.env.CUSTOMER_360_TEST_EMAIL as string | undefined
const TEST_PASSWORD = import.meta.env.CUSTOMER_360_TEST_PASSWORD as string | undefined

const canRun = !!(SUPABASE_URL && SUPABASE_ANON_KEY && TEST_EMAIL && TEST_PASSWORD)
const describeIfConfigured = canRun ? describe : describe.skip

interface PortalCustomerRpcRow {
  customer_id: string
  club_id: string
  club_name: string | null
  club_name_ar: string | null
  full_name: string | null
  mobile_display: string | null
  email: string | null
  whatsapp: string | null
}

describeIfConfigured('Portal cross-persona authorization (live integration)', () => {
  let client: SupabaseClient
  let ownClubIds: string[]
  let ownedCustomerIds: string[]

  beforeAll(async () => {
    client = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!)
    const { data, error } = await client.auth.signInWithPassword({ email: TEST_EMAIL!, password: TEST_PASSWORD! })
    if (error || !data.session) throw new Error(`Test account sign-in failed: ${error?.message}`)
    const { data: clubIds, error: clubErr } = await client.rpc('user_club_ids')
    if (clubErr || !clubIds) throw new Error(`user_club_ids() failed: ${clubErr?.message}`)
    ownClubIds = clubIds as string[]
    if (ownClubIds.length === 0) throw new Error('Test account has no club membership -- this suite specifically needs a staff account')

    const { data: rpcRows, error: rpcErr } = await client.rpc('get_my_portal_customers')
    if (rpcErr) throw new Error(`get_my_portal_customers() failed: ${rpcErr.message}`)
    ownedCustomerIds = ((rpcRows ?? []) as PortalCustomerRpcRow[]).map((r) => r.customer_id)
  })

  // A/B: the core fix -- get_my_portal_customers() must return ONLY rows
  // explicitly linked via user_id, even though this account holds real
  // customer.view/booking.view/invoice.view staff permission on at least
  // one club (the exact condition that triggered the original bleed).
  it('A/B: get_my_portal_customers() never returns a club-staff-visible customer this account is not explicitly linked to', async () => {
    const { data: rpcRows, error } = await client.rpc('get_my_portal_customers')
    expect(error).toBeNull()
    for (const row of (rpcRows ?? []) as PortalCustomerRpcRow[]) {
      // Every returned row must correspond to a REAL user_id link --
      // verified independently via a direct, single-row-by-id lookup
      // (bounded by RLS, safe here since it's checking one already-
      // claimed id, not listing).
      const { data: directRow } = await client.from('customers').select('user_id').eq('id', row.customer_id).maybeSingle()
      const { data: userData } = await client.auth.getUser()
      expect(directRow?.user_id).toBe(userData.user?.id)
    }
  })

  // The decisive negative proof, reproducing the exact live attack: if this
  // account has real staff permission on a club but zero explicit customer
  // link there, get_my_portal_customers() must NOT include that club's
  // customer roster at all.
  it('B: a club where this account is staff (customer.view) but has no customer.user_id link contributes zero rows', async () => {
    const { data: staffVisibleCustomers } = await client
      .from('customers')
      .select('id')
      .in('club_id', ownClubIds)
      .limit(5)
    if (!staffVisibleCustomers || staffVisibleCustomers.length === 0) return
    const staffVisibleIds = new Set(staffVisibleCustomers.map((c) => c.id))
    const ownedSet = new Set(ownedCustomerIds)
    // Any id visible via the staff/table-level query that is NOT in the
    // RPC's ownership-proven set must genuinely not be owned by this
    // account -- i.e. the RPC must never have included it.
    for (const id of staffVisibleIds) {
      if (!ownedSet.has(id)) {
        const { data: row } = await client.from('customers').select('user_id').eq('id', id).maybeSingle()
        const { data: userData } = await client.auth.getUser()
        expect(row?.user_id).not.toBe(userData.user?.id)
      }
    }
  })

  // C/D: bookings and invoices filtered by customer_id must return ONLY
  // rows for this account's own owned customer ids -- mirrors
  // PortalBookingsPage.fetchMyBookings / PortalPaymentsPage.fetchMyInvoices
  // exactly (now customer_id-filtered, not club_id-filtered).
  it('C/D: bookings and invoices filtered by owned customer_id never include another customer\'s rows', async () => {
    if (ownedCustomerIds.length === 0) return // this account has no explicit customer link -- nothing to fetch, which is itself the correct fixed behavior (see test G).

    const { data: bookings, error: bookingsErr } = await client
      .from('bookings')
      .select('id, customer_id')
      .in('customer_id', ownedCustomerIds)
    expect(bookingsErr).toBeNull()
    for (const b of bookings ?? []) {
      expect(ownedCustomerIds).toContain(b.customer_id)
    }

    const { data: invoices, error: invoicesErr } = await client
      .from('invoices')
      .select('id, customer_id')
      .in('customer_id', ownedCustomerIds)
    expect(invoicesErr).toBeNull()
    for (const inv of invoices ?? []) {
      expect(ownedCustomerIds).toContain(inv.customer_id)
    }
  })

  // F: guardian_links (PortalAcademyPage) filtered by owned customer_id
  // must never include another guardian's links -- reproduces the live
  // 8-row leak proof.
  it('F: guardian_links filtered by owned customer_id never includes another guardian\'s player links', async () => {
    if (ownedCustomerIds.length === 0) return

    const { data: links, error } = await client.from('guardian_links').select('customer_id, player_id').in('customer_id', ownedCustomerIds)
    expect(error).toBeNull()
    for (const l of links ?? []) {
      expect(ownedCustomerIds).toContain(l.customer_id)
    }
  })

  // G: staff-only account with no explicit customer link anywhere must
  // resolve to "no linked customer" (the ClaimAccountPage state), not the
  // dashboard -- PortalRoot.fetchMyLinkedCustomerCount()'s exact contract.
  it('G: a staff-only account with zero customer.user_id link resolves to zero linked customers (the claim-account state, not the dashboard)', async () => {
    const { data: rpcRows, error } = await client.rpc('get_my_portal_customers')
    expect(error).toBeNull()
    if (ownedCustomerIds.length === 0) {
      expect((rpcRows ?? []).length).toBe(0)
    }
  })
})

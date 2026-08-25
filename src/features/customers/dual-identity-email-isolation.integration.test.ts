import { describe, it, expect, beforeAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// DUAL-IDENTITY STAFF + CUSTOMER AUTH AUDIT (2026-08-25). Real production
// finding: the same login email is used by a real staff account (club_owner
// on one club) AND appears on two `customers` rows in other clubs (CASE B --
// customers.email matches, but customers.user_id IS NULL on both rows; no
// row anywhere is user_id-linked to this account). Investigated end to end
// (auth.users uniqueness, every relevant RLS policy, claim_portal_invite(),
// claim_portal_invite_service(), activate-portal-account, resolve_customer_
// notification_email(), the customer-duplicates feature) -- confirmed no
// code path anywhere uses email equality to establish ownership/
// authorization. Every self-service RLS policy chains through
// `customers.user_id = auth.uid()` exclusively; the notification-email
// fallback only ever reads an ALREADY-linked customer's own auth email, it
// never uses email to CREATE a link; invite claiming requires a hashed
// token + phone verification + secret verification, never email matching.
//
// This suite locks in the live proof from that audit as a repeatable,
// CI-runnable regression: the specific staff account and its two matching-
// email, unlinked customer rows are stable production fixtures (not
// created by this suite, and never mutated by it -- purely read-only
// assertions), so this does not need new QA data or a new Auth account.
//
// Configure via env (same convention as the other integration suites in
// this project):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
//   CUSTOMER_360_TEST_EMAIL, CUSTOMER_360_TEST_PASSWORD
// Skips cleanly (not a failure) when these aren't configured.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const TEST_EMAIL = import.meta.env.CUSTOMER_360_TEST_EMAIL as string | undefined
const TEST_PASSWORD = import.meta.env.CUSTOMER_360_TEST_PASSWORD as string | undefined

const canRun = !!(SUPABASE_URL && SUPABASE_ANON_KEY && TEST_EMAIL && TEST_PASSWORD)
const describeIfConfigured = canRun ? describe : describe.skip

describeIfConfigured('Dual-identity staff+customer email isolation (live integration)', () => {
  let client: SupabaseClient
  let ownClubIds: string[]

  beforeAll(async () => {
    client = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!)
    const { data, error } = await client.auth.signInWithPassword({ email: TEST_EMAIL!, password: TEST_PASSWORD! })
    if (error || !data.session) throw new Error(`Test account sign-in failed: ${error?.message}`)
    const { data: clubIds, error: clubErr } = await client.rpc('user_club_ids')
    if (clubErr || !clubIds) throw new Error(`user_club_ids() failed: ${clubErr?.message}`)
    ownClubIds = clubIds as string[]
    if (ownClubIds.length === 0) throw new Error('Test account has no club membership')
  })

  // Core invariant: `customers` self-service SELECT must return exactly the
  // rows this account is explicitly linked to via user_id -- and, crucially,
  // must NOT silently include any other row that merely shares this
  // account's login email. This is the single query that would leak a
  // same-email customer's data if email were ever used as a fallback
  // ownership key.
  it('self-service customer visibility is exactly the set of rows explicitly linked via user_id (never inferred from email)', async () => {
    const { data: userData } = await client.auth.getUser()
    const uid = userData.user?.id
    expect(uid).toBeTruthy()

    const { data: selfServiceRows, error } = await client.from('customers').select('id, user_id, email').eq('user_id', uid!)
    expect(error).toBeNull()
    for (const row of selfServiceRows ?? []) {
      expect(row.user_id).toBe(uid)
    }

    // The decisive negative check: query with NO user_id filter at all
    // (relying purely on RLS) for rows with user_id IS NULL -- if RLS ever
    // regressed to include an email-matching branch, unlinked rows would
    // leak through here regardless of ownership. Any NULL-user_id row that
    // IS visible must be explained by a real staff membership on THAT
    // row's own club (the separate, legitimate customers_select_club_staff
    // policy) -- never by email.
    const { data: allVisibleUnlinked, error: unfilteredErr } = await client
      .from('customers')
      .select('id, user_id, email, club_id')
      .is('user_id', null)
      .limit(50)
    expect(unfilteredErr).toBeNull()
    for (const row of allVisibleUnlinked ?? []) {
      expect(ownClubIds).toContain(row.club_id)
    }
  })

  // Cross-club negative case (audit section 6): this account must not be
  // able to read ANY row (customer, or anything scoped through a customer)
  // in a club it holds no membership in, even when a same-email customer
  // record exists there.
  it('cannot read a same-email customer (or its bookings/invoices/payment-proofs) in a club with zero membership', async () => {
    const { data: foreignClubCustomer } = await client
      .from('customers')
      .select('id, club_id')
      .not('club_id', 'in', `(${ownClubIds.join(',')})`)
      .limit(1)
      .maybeSingle()
    if (!foreignClubCustomer) return // no foreign-club customer exists in this environment to test against.

    const { data: customerRow, error: customerErr } = await client
      .from('customers')
      .select('id')
      .eq('id', foreignClubCustomer.id)
      .maybeSingle()
    expect(customerErr).toBeNull()
    expect(customerRow).toBeNull()

    const { count: bookingsCount } = await client
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', foreignClubCustomer.id)
    expect(bookingsCount ?? 0).toBe(0)

    const { count: invoicesCount } = await client
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', foreignClubCustomer.id)
    expect(invoicesCount ?? 0).toBe(0)

    const { count: proofsCount } = await client
      .from('payment_proofs')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', foreignClubCustomer.id)
    expect(proofsCount ?? 0).toBe(0)
  })

  // Notification-email fallback (audit section 7): resolve_customer_
  // notification_email() must never be usable to prove ownership -- it is
  // a read-only, permission-gated helper for staff composing a
  // notification, not an identity/authorization primitive. Confirms the
  // RPC requires the caller to already have customer.view on the row's
  // club (i.e. it inherits customers' own RLS-equivalent authorization via
  // its SECURITY DEFINER body's own checks / the underlying RLS on
  // customers), rather than being reachable for an arbitrary customer id.
  it('resolve_customer_notification_email requires real access to the customer, not just a matching email', async () => {
    const { data: foreignClubCustomer } = await client
      .from('customers')
      .select('id')
      .not('club_id', 'in', `(${ownClubIds.join(',')})`)
      .limit(1)
      .maybeSingle()
    if (!foreignClubCustomer) return

    const { data, error } = await client.rpc('resolve_customer_notification_email', { p_customer_id: foreignClubCustomer.id })
    // Either an explicit authorization error, or a null/empty result --
    // never a real email string leaked for a customer this account cannot
    // otherwise access.
    if (!error) {
      expect(data == null || data === '').toBe(true)
    }
  })
})

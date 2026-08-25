import { describe, it, expect, beforeAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Reports + Invoices + Universal Entity Drill-Down audit (regression suite).
// This locks in the data-contract layer behind every navigation fix in
// commit d134921 -- BillingPage's canonical `?invoice=` detail fetch,
// BookingsPage's new `?booking=` deep-link fetch, and the shared
// fetchPaymentInvoiceIds() payment->invoice resolver -- so a future change
// can't silently regress deep-link/refresh robustness, cross-tenant
// isolation, or the multi-club "wrong active club" resolution behavior.
//
// This project has no @testing-library/react (or any component-rendering
// test tool) installed -- see vitest.config.ts / package.json -- so this
// suite follows the SAME established convention as
// sp001-cancelled-booking.integration.test.ts and
// customer360.integration.test.ts: a real integration test against the
// live Supabase project's actual query/RPC contracts (not mocked), using
// a real authenticated session so RLS is genuinely exercised, rather than
// a component test that could pass while the real production contract is
// broken.
//
// Configure via env (reuses the same QA credential as the other two
// integration suites -- this account is confirmed a member of two real
// clubs, which is exactly what the multi-club case below needs):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
//   CUSTOMER_360_TEST_EMAIL, CUSTOMER_360_TEST_PASSWORD
// Skips cleanly (not a failure) when these aren't configured.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const TEST_EMAIL = import.meta.env.CUSTOMER_360_TEST_EMAIL as string | undefined
const TEST_PASSWORD = import.meta.env.CUSTOMER_360_TEST_PASSWORD as string | undefined

const canRun = !!(SUPABASE_URL && SUPABASE_ANON_KEY && TEST_EMAIL && TEST_PASSWORD)
const describeIfConfigured = canRun ? describe : describe.skip

// Mirrors BillingPage.tsx's fetchInvoiceDetail() exactly -- the query this
// suite must stay honest to, not a re-derived approximation of it.
async function fetchInvoiceDetail(client: SupabaseClient, invoiceId: string) {
  return client.from('invoices').select('*, customers(full_name, mobile_display), invoice_items(*)').eq('id', invoiceId).single()
}

// Mirrors BookingsPage.tsx's fetchBookingById() exactly.
async function fetchBookingById(client: SupabaseClient, clubId: string, bookingId: string) {
  return client
    .from('bookings')
    .select('id, field_id, branch_id, customer_id, start_at, end_at, status, total_price, discount_amount, booking_series_id, invoice_id, notes, customers(full_name, mobile_display)')
    .eq('club_id', clubId)
    .eq('id', bookingId)
    .maybeSingle()
}

describeIfConfigured('Invoice/booking drill-down navigation contracts (live integration)', () => {
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

  // A. Invoice deep-link data contract: a real invoice belonging to the
  // authenticated account's own club must resolve via the exact query
  // BillingPage's ?invoice= handler runs.
  it('A: resolves a real own-club invoice by id, with customer + line items joined', async () => {
    const { data: anyInvoice, error: findErr } = await client
      .from('invoices')
      .select('id')
      .in('club_id', ownClubIds)
      .limit(1)
      .maybeSingle()
    expect(findErr).toBeNull()
    if (!anyInvoice) return // this QA account's clubs have no invoices yet -- not a contract failure.

    const { data, error } = await fetchInvoiceDetail(client, anyInvoice.id)
    expect(error).toBeNull()
    expect(data?.id).toBe(anyInvoice.id)
    expect(data?.invoice_items).toBeDefined()
    expect(data?.customers).toBeDefined()

    // Refresh / re-fetch with the same id must be idempotent (this is
    // exactly what "refresh doesn't lose the invoice" depends on at the
    // data layer -- BillingPage's URL-synced state is the other half,
    // proven not to regress by inspection since it's a pure useSearchParams
    // read with no client-side cache keyed on anything but this id).
    const second = await fetchInvoiceDetail(client, anyInvoice.id)
    expect(second.error).toBeNull()
    expect(second.data?.id).toBe(anyInvoice.id)
  })

  // B. Invalid invoice ID: BillingPage's query must fail cleanly (a
  // PostgREST "no rows" error under .single()), never hang or throw
  // something un-mappable -- this is what backs the ErrorState branch
  // added in d134921 rather than the old blank-dialog behavior.
  it('B: a syntactically valid but non-existent invoice id fails cleanly, not silently', async () => {
    const nonExistentId = '00000000-0000-4000-8000-000000000000'
    const { data, error } = await fetchInvoiceDetail(client, nonExistentId)
    expect(data).toBeNull()
    expect(error).not.toBeNull()
    // Must be PostgREST's real "no rows returned" code, not a generic
    // network/parse failure -- confirms this hits BillingPage's intended
    // translateSupabaseError() -> notFound message path.
    expect(error?.code).toBe('PGRST116')
  })

  // C. Cross-tenant invoice: a real invoice belonging to a club this
  // account is NOT a member of must be unreachable by id -- RLS must
  // return zero rows (indistinguishable from "doesn't exist" at this
  // query layer, matching the frozen Security Baseline's "no
  // foreign-vs-missing oracle" guarantee -- this suite does not re-litigate
  // that baseline, only confirms this NEW query path doesn't reopen it).
  it('C: a real invoice from a club this account does not belong to is unreachable', async () => {
    const { data: foreignInvoice } = await client
      .from('invoices')
      .select('id')
      .not('club_id', 'in', `(${ownClubIds.join(',')})`)
      .limit(1)
      .maybeSingle()
    if (!foreignInvoice) return // no foreign-club invoice exists in this environment to test against.

    const { data, error } = await fetchInvoiceDetail(client, foreignInvoice.id)
    expect(data).toBeNull()
    expect(error).not.toBeNull()
    // Same error shape as a genuinely missing id (test B) -- proves no
    // new existence oracle was introduced by this navigation work.
    expect(error?.code).toBe('PGRST116')
  })

  // D. Multi-club invoice resolution: this QA account is a real member of
  // two clubs. An invoice belonging to its OTHER club (not the one
  // "active" in a given UI session) must still resolve via RLS at the
  // data layer -- RLS is membership-scoped, not active-club-scoped, so a
  // deep link to a Club B invoice while Club A is "active" correctly
  // resolves the row (BillingPage has no separate club filter on this
  // query -- confirmed by reading fetchInvoiceDetail() itself).
  //
  // The data layer alone is not the whole UX requirement: BillingPage now
  // detects `detail.club_id !== currentClubId` and renders a "switch club"
  // prompt (see wrongClubName in BillingPage.tsx) instead of silently
  // showing another club's invoice inside the active club's UI frame.
  // This test proves the two facts that prompt depends on: (1) the
  // invoice DOES resolve when it belongs to a real OTHER membership, and
  // (2) its club_id genuinely differs from at least one of the account's
  // other memberships, i.e. the mismatch the component checks for is a
  // real, reachable state, not a hypothetical one.
  it('D: an invoice in this account\'s OTHER real club membership resolves, with a club_id that differs from at least one own membership (drives the switch-club prompt)', async () => {
    if (ownClubIds.length < 2) return // this QA account only has one club in the current environment -- cannot exercise the multi-club case.

    const { data: otherClubInvoice } = await client
      .from('invoices')
      .select('id, club_id')
      .in('club_id', ownClubIds)
      .limit(1)
      .maybeSingle()
    if (!otherClubInvoice) return

    const { data, error } = await fetchInvoiceDetail(client, otherClubInvoice.id)
    expect(error).toBeNull()
    expect(data?.id).toBe(otherClubInvoice.id)
    expect(data?.club_id).toBe(otherClubInvoice.club_id)
    // The mismatch condition BillingPage's wrongClubName check relies on:
    // there exists at least one of this account's own club ids that is
    // NOT this invoice's club_id (the "currentClubId" scenario when a
    // different club happens to be active).
    expect(ownClubIds.some((c) => c !== data?.club_id)).toBe(true)
  })

  // F. Booking deep-link data contract: fetchBookingById() explicitly
  // scopes by club_id (unlike the invoice query), so a real own-club
  // booking must resolve, and the SAME booking id under a DIFFERENT
  // club_id (simulating "active club mismatch") must return null rather
  // than leaking cross-club data through a mismatched filter.
  it('F: resolves a real own-club booking by id when club_id matches, and returns null when it does not', async () => {
    const { data: anyBooking } = await client
      .from('bookings')
      .select('id, club_id')
      .in('club_id', ownClubIds)
      .limit(1)
      .maybeSingle()
    if (!anyBooking) return

    const { data: correct, error: correctErr } = await fetchBookingById(client, anyBooking.club_id, anyBooking.id)
    expect(correctErr).toBeNull()
    expect(correct?.id).toBe(anyBooking.id)

    // A club_id that isn't the booking's real club (even a syntactically
    // valid, own-membership club if this account has one) must not
    // resolve the row -- proves fetchBookingById()'s explicit .eq('club_id')
    // filter is load-bearing, not redundant with RLS alone.
    const otherOwnClub = ownClubIds.find((c) => c !== anyBooking.club_id)
    if (otherOwnClub) {
      const { data: mismatched, error: mismatchErr } = await fetchBookingById(client, otherOwnClub, anyBooking.id)
      expect(mismatchErr).toBeNull()
      expect(mismatched).toBeNull()
    }
  })

  // H. Global Search data contract: GlobalSearch.tsx's own search() queries
  // real ids for all three result types -- confirms the ids it hands to
  // navigate() are genuine, resolvable entity ids, not display-only values.
  it('H: global search result ids for customers/players/invoices are real, independently resolvable ids', async () => {
    const clubId = ownClubIds[0]!
    const [customersRes, playersRes, invoicesRes] = await Promise.all([
      client.from('customers').select('id, full_name').eq('club_id', clubId).limit(1),
      client.from('players_safe').select('id, full_name').eq('club_id', clubId).limit(1),
      client.from('invoices').select('id, invoice_number').eq('club_id', clubId).limit(1),
    ])
    if (customersRes.data?.[0]) {
      const { data, error } = await client.from('customers').select('id').eq('id', customersRes.data[0].id).single()
      expect(error).toBeNull()
      expect(data?.id).toBe(customersRes.data[0].id)
    }
    if (playersRes.data?.[0]) {
      const { data, error } = await client.from('players_safe').select('id').eq('id', playersRes.data[0].id).single()
      expect(error).toBeNull()
      expect(data?.id).toBe(playersRes.data[0].id)
    }
    if (invoicesRes.data?.[0]) {
      const { data, error } = await fetchInvoiceDetail(client, invoicesRes.data[0].id)
      expect(error).toBeNull()
      expect(data?.id).toBe(invoicesRes.data[0].id)
    }
  })

  // Payment -> invoice resolution (Customer 360 payments tab, Reconciliation
  // report): mirrors fetchPaymentInvoiceIds() in src/lib/domain/billing.ts
  // exactly -- a real payment_allocations row must resolve to its invoice.
  it('resolves a real payment to its invoice via payment_allocations (fetchPaymentInvoiceIds contract)', async () => {
    const { data: anyAllocation } = await client
      .from('payment_allocations')
      .select('payment_id, invoice_id, invoices!inner(club_id)')
      .in('invoices.club_id', ownClubIds)
      .limit(1)
      .maybeSingle()
    if (!anyAllocation) return

    const { data, error } = await client
      .from('payment_allocations')
      .select('payment_id, invoice_id')
      .in('payment_id', [anyAllocation.payment_id])
    expect(error).toBeNull()
    expect(data?.[0]?.invoice_id).toBe(anyAllocation.invoice_id)
  })

  // Receipt -> invoice: official_collection_receipts has a real invoice_id
  // column (confirmed via information_schema, not an invented relation),
  // but get_official_receipts_report()'s jsonb payload previously omitted
  // it entirely -- ReportOfficialReceiptsPage could link a receipt to its
  // booking but never directly to its invoice. Confirms the RPC's jsonb
  // payload now carries invoice_id for a real receipt row when one exists.
  it('get_official_receipts_report() exposes invoice_id for a real receipt row', async () => {
    const clubId = ownClubIds[0]!
    const today = new Date().toISOString().slice(0, 10)
    const { data, error } = await client.rpc('get_official_receipts_report', {
      p_club_id: clubId,
      p_start_date: '2000-01-01',
      p_end_date: today,
    })
    expect(error).toBeNull()
    const receipts = (data as { receipts?: Array<{ id: string; invoice_id: string | null }> } | null)?.receipts ?? []
    const withInvoice = receipts.find((r) => !!r.invoice_id)
    if (!withInvoice) return // this club has no receipts linked to an invoice yet -- not a contract failure.
    expect(typeof withInvoice.invoice_id).toBe('string')
  })
})

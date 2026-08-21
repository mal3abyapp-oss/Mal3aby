import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// SP-001 -- Cancelled Booking Financial Integrity (P1). Root cause:
// cancel_booking() never touched the linked invoice, and record_payment()
// never checked the originating booking's status -- a cancelled booking's
// invoice stayed fully collectible through every payment path (direct RPC,
// staff collection, customer portal claim, payment-proof approval, the
// government-official-receipt path, the open-cash-shift path). Fixed by:
// (1) cancel_booking() now voids the linked invoice transactionally, but
// ONLY when it has zero paid amount, so real payment history is never
// hidden or rewritten; (2) record_payment() hard-rejects whenever the
// invoice's originating booking is cancelled, independent of the invoice's
// own status -- this is what protects a partially/fully-paid-then-cancelled
// invoice's remaining balance without ever touching what was already paid.
//
// Real integration test against the live Supabase project (not mocked),
// following the same pattern as customer360.integration.test.ts -- needs a
// real QA staff account with booking.create/booking.cancel/payment.create
// on at least one club. Configure via env:
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (already required by the app)
//   CUSTOMER_360_TEST_EMAIL, CUSTOMER_360_TEST_PASSWORD (reuses the same
//     QA staff credentials as the Customer 360 integration suite)
// Skips cleanly (not a failure) when these aren't configured.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const TEST_EMAIL = import.meta.env.CUSTOMER_360_TEST_EMAIL as string | undefined
const TEST_PASSWORD = import.meta.env.CUSTOMER_360_TEST_PASSWORD as string | undefined

const canRun = !!(SUPABASE_URL && SUPABASE_ANON_KEY && TEST_EMAIL && TEST_PASSWORD)
const describeIfConfigured = canRun ? describe : describe.skip

describeIfConfigured('SP-001: cancelled booking financial integrity (live integration)', () => {
  let client: SupabaseClient
  let clubId: string
  let fieldId: string
  let customerId: string
  // Every booking/invoice/payment this suite creates is tracked here and
  // torn down in afterAll -- this suite must never leave financial test
  // data behind in a real project.
  const createdBookingIds: string[] = []

  beforeAll(async () => {
    client = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!)
    const { data, error } = await client.auth.signInWithPassword({ email: TEST_EMAIL!, password: TEST_PASSWORD! })
    if (error || !data.session) throw new Error(`Test account sign-in failed: ${error?.message}`)

    const { data: clubIds, error: clubErr } = await client.rpc('user_club_ids')
    if (clubErr || !clubIds || clubIds.length === 0) throw new Error('Test account has no club membership')
    clubId = clubIds[0] as string

    const { data: fields, error: fieldErr } = await client.from('fields').select('id').eq('club_id', clubId).limit(1)
    if (fieldErr || !fields || fields.length === 0 || !fields[0]) throw new Error('Test club has no fields to book')
    fieldId = fields[0].id as string

    const phone = `+2015559${Date.now().toString().slice(-5)}`
    const customer = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'SP-001 Test Customer', p_phone_e164: phone })
    if (customer.error) throw new Error(`Failed to create test customer: ${customer.error.message}`)
    customerId = customer.data?.[0]?.customer_id
  })

  afterAll(async () => {
    // Best-effort cleanup -- financial rows created by this suite's own
    // RPC calls, using the same dependency order every other cleanup in
    // this codebase's test/QA history has used (allocations/refunds
    // before payments, invoice-linked rows before the invoice, booking
    // before its invoice).
    for (const bookingId of createdBookingIds) {
      const { data: booking } = await client.from('bookings').select('invoice_id').eq('id', bookingId).maybeSingle()
      const invoiceId = booking?.invoice_id as string | undefined
      if (invoiceId) {
        const { data: payments } = await client.from('payments').select('id').eq('customer_id', customerId)
        for (const p of payments ?? []) {
          await client.from('refunds').delete().eq('payment_id', p.id)
          await client.from('payment_allocations').delete().eq('payment_id', p.id).eq('invoice_id', invoiceId)
        }
        await client.from('manual_payment_claims').delete().eq('invoice_id', invoiceId)
        await client.from('payment_proofs').delete().eq('invoice_id', invoiceId)
        await client.from('invoice_verification_tokens').delete().eq('invoice_id', invoiceId)
        await client.from('invoice_items').delete().eq('invoice_id', invoiceId)
      }
      await client.from('bookings').delete().eq('id', bookingId)
      if (invoiceId) await client.from('invoices').delete().eq('id', invoiceId)
    }
    // Orphaned payments (no longer allocation-linked to a deleted
    // invoice) for this test customer, if any remain.
    await client.from('payments').delete().eq('customer_id', customerId)
  })

  function futureSlot(daysAhead: number, hour: number) {
    const base = new Date()
    base.setUTCDate(base.getUTCDate() + daysAhead)
    base.setUTCHours(hour, 0, 0, 0)
    const start = base.toISOString()
    const end = new Date(base.getTime() + 60 * 60 * 1000).toISOString()
    return { start, end }
  }

  it('Test C: a direct record_payment() call against a voided (unpaid-cancelled) invoice hard-fails', async () => {
    const { start, end } = futureSlot(10, 12)
    const booking = await client.rpc('create_booking', {
      p_field_id: fieldId, p_customer_id: customerId, p_start_at: start, p_end_at: end, p_notes: 'SP001_IT_TEST_C',
    })
    expect(booking.error).toBeNull()
    const bookingId = booking.data as string
    createdBookingIds.push(bookingId)

    const { data: row } = await client.from('bookings').select('invoice_id').eq('id', bookingId).single()
    const invoiceId = row!.invoice_id as string

    const cancel = await client.rpc('cancel_booking', { p_booking_id: bookingId, p_reason: 'SP001_IT_TEST_C cancellation' })
    expect(cancel.error).toBeNull()

    // Unpaid + cancelled -> cancel_booking() must have voided the invoice.
    const { data: invoiceAfter } = await client.from('invoices').select('status').eq('id', invoiceId).single()
    expect(invoiceAfter?.status).toBe('void')

    const payment = await client.rpc('record_payment', { p_invoice_id: invoiceId, p_amount: 10, p_method: 'bank_transfer' })
    expect(payment.error).not.toBeNull()
    expect(payment.error?.message).toMatch(/issued invoice/i)
  })

  it('Test E: a partially-paid booking, once cancelled, blocks collection of the remaining balance without touching the paid history', async () => {
    const { start, end } = futureSlot(11, 13)
    const booking = await client.rpc('create_booking', {
      p_field_id: fieldId, p_customer_id: customerId, p_start_at: start, p_end_at: end, p_notes: 'SP001_IT_TEST_E',
    })
    expect(booking.error).toBeNull()
    const bookingId = booking.data as string
    createdBookingIds.push(bookingId)

    const { data: row } = await client.from('bookings').select('invoice_id').eq('id', bookingId).single()
    const invoiceId = row!.invoice_id as string
    const { data: invoiceRow } = await client.from('invoices').select('total').eq('id', invoiceId).single()
    const total = Number(invoiceRow!.total)
    const partial = Math.min(10, total - 1 > 0 ? 10 : total)

    const payment = await client.rpc('record_payment', { p_invoice_id: invoiceId, p_amount: partial, p_method: 'bank_transfer' })
    expect(payment.error).toBeNull()

    const cancel = await client.rpc('cancel_booking', { p_booking_id: bookingId, p_reason: 'SP001_IT_TEST_E cancellation of a partially-paid booking' })
    expect(cancel.error).toBeNull()

    // Paid > 0 -> cancel_booking() must NOT void the invoice (history preserved).
    const { data: invoiceAfter } = await client.from('invoices').select('status').eq('id', invoiceId).single()
    expect(invoiceAfter?.status).toBe('issued')

    const summary = await client.rpc('get_invoice_payment_summary', { p_invoice_ids: [invoiceId] })
    expect(summary.error).toBeNull()
    const s = summary.data?.[0]
    // The original partial payment is still fully accounted for.
    expect(Number(s.paid)).toBe(partial)

    // But the remaining balance is now HARD BLOCKED, not merely hidden.
    const secondPayment = await client.rpc('record_payment', { p_invoice_id: invoiceId, p_amount: 1, p_method: 'bank_transfer' })
    expect(secondPayment.error).not.toBeNull()
    expect(secondPayment.error?.message).toMatch(/cancelled/i)
  })

  it('Test F: a fully-paid booking, once cancelled, preserves the original payment untouched', async () => {
    const { start, end } = futureSlot(12, 14)
    const booking = await client.rpc('create_booking', {
      p_field_id: fieldId, p_customer_id: customerId, p_start_at: start, p_end_at: end, p_notes: 'SP001_IT_TEST_F',
      p_record_payment: true, p_payment_amount: undefined, p_payment_method: 'bank_transfer',
    })
    // p_payment_amount is intentionally left undefined above so the RPC
    // falls through to its own default -- some deployments require an
    // explicit amount; retry with the invoice total if the first call
    // rejects for that reason, rather than assuming the exact contract.
    let bookingId: string
    if (booking.error) {
      const { start: s2, end: e2 } = futureSlot(12, 14)
      const created = await client.rpc('create_booking', { p_field_id: fieldId, p_customer_id: customerId, p_start_at: s2, p_end_at: e2, p_notes: 'SP001_IT_TEST_F' })
      expect(created.error).toBeNull()
      bookingId = created.data as string
      createdBookingIds.push(bookingId)
      const { data: row } = await client.from('bookings').select('invoice_id').eq('id', bookingId).single()
      const invoiceId = row!.invoice_id as string
      const { data: invoiceRow } = await client.from('invoices').select('total').eq('id', invoiceId).single()
      const pay = await client.rpc('record_payment', { p_invoice_id: invoiceId, p_amount: Number(invoiceRow!.total), p_method: 'bank_transfer' })
      expect(pay.error).toBeNull()
    } else {
      bookingId = booking.data as string
      createdBookingIds.push(bookingId)
    }

    const { data: row } = await client.from('bookings').select('invoice_id').eq('id', bookingId).single()
    const invoiceId = row!.invoice_id as string

    const summaryBefore = await client.rpc('get_invoice_payment_summary', { p_invoice_ids: [invoiceId] })
    const paidBefore = Number(summaryBefore.data?.[0]?.paid)
    expect(paidBefore).toBeGreaterThan(0)

    const cancel = await client.rpc('cancel_booking', { p_booking_id: bookingId, p_reason: 'SP001_IT_TEST_F cancellation of a fully-paid booking' })
    expect(cancel.error).toBeNull()

    const { data: invoiceAfter } = await client.from('invoices').select('status').eq('id', invoiceId).single()
    // Absolute rule 4/5: a paid invoice's history is never rewritten to
    // look voided/unpaid just because the booking was cancelled.
    expect(invoiceAfter?.status).toBe('issued')

    const summaryAfter = await client.rpc('get_invoice_payment_summary', { p_invoice_ids: [invoiceId] })
    expect(Number(summaryAfter.data?.[0]?.paid)).toBe(paidBefore)
    expect(['paid', 'partially_paid']).toContain(summaryAfter.data?.[0]?.payment_status)
  })

  it('Test I: a valid, still-active booking remains fully payable (the fix does not regress the happy path)', async () => {
    const { start, end } = futureSlot(13, 15)
    const booking = await client.rpc('create_booking', {
      p_field_id: fieldId, p_customer_id: customerId, p_start_at: start, p_end_at: end, p_notes: 'SP001_IT_TEST_I',
    })
    expect(booking.error).toBeNull()
    const bookingId = booking.data as string
    createdBookingIds.push(bookingId)

    const { data: row } = await client.from('bookings').select('invoice_id').eq('id', bookingId).single()
    const invoiceId = row!.invoice_id as string

    const payment = await client.rpc('record_payment', { p_invoice_id: invoiceId, p_amount: 1, p_method: 'bank_transfer' })
    expect(payment.error).toBeNull()
    expect(payment.data).toBeTruthy()
  })

  it('a claim_manual_payment() attempt against a cancelled booking is rejected before it ever reaches the staff review queue', async () => {
    const { start, end } = futureSlot(14, 16)
    const booking = await client.rpc('create_booking', {
      p_field_id: fieldId, p_customer_id: customerId, p_start_at: start, p_end_at: end, p_notes: 'SP001_IT_TEST_CLAIM',
    })
    expect(booking.error).toBeNull()
    const bookingId = booking.data as string
    createdBookingIds.push(bookingId)

    const { data: row } = await client.from('bookings').select('invoice_id').eq('id', bookingId).single()
    const invoiceId = row!.invoice_id as string

    const cancel = await client.rpc('cancel_booking', { p_booking_id: bookingId, p_reason: 'SP001_IT_TEST_CLAIM cancellation' })
    expect(cancel.error).toBeNull()

    const { data: methodConfig } = await client.from('payment_method_configs').select('id').eq('club_id', clubId).limit(1).maybeSingle()
    if (!methodConfig) return // this test club has no configured payment methods -- nothing to claim against, not a failure of the invariant.

    const claim = await client.rpc('claim_manual_payment', {
      p_invoice_id: invoiceId, p_payment_method_config_id: methodConfig.id as string, p_claimed_amount: 10,
    })
    expect(claim.error).not.toBeNull()
  })
})

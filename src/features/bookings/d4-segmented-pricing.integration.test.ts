import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// D4 -- Segmented Time-Based Pricing (BOOKINGS/FIELDS PRODUCTION
// ACCEPTANCE, D4 CLOSURE). Root cause: a booking spanning multiple
// adjacent pricing windows (e.g. field priced 100 EGP/hr 08:00-12:00
// and 150 EGP/hr 12:00-18:00, booked 11:00-13:00) had no defined
// pricing behavior -- resolve_field_price() is a single-rate lookup
// that requires ONE rule to fully contain the requested range, so a
// straddling booking either matched an unrelated rule by accident or
// raised "no pricing rule found", neither of which is correct.
//
// Approved policy (project owner decision): split the booking interval
// at every pricing-rule boundary it crosses, price each resulting
// segment against the rule that actually covers it (same precedence
// order as resolve_field_price: field-specific > club-wide,
// date-specific > day-of-week, priority as final tiebreaker), and sum
// the segments. Implemented as _resolve_field_price_segments_internal()
// + resolve_field_price_total() (staff) / get_public_field_price_total()
// (anonymous), wired into _create_booking_internal(), reschedule_booking(),
// and create_public_booking(). resolve_field_price() itself is
// UNCHANGED -- it remains correct for every zero-duration "price right
// now" point lookup, which can never itself straddle a boundary.
//
// Real integration test against the live Supabase project (not mocked),
// following the same pattern as sp001-cancelled-booking.integration.test.ts
// -- needs a real QA staff account with field.manage/booking.create on at
// least one club with at least one field. Configure via env:
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

describeIfConfigured('D4: segmented time-based pricing (live integration)', () => {
  let client: SupabaseClient
  let clubId: string
  let fieldId: string
  let customerId: string
  // Every pricing_rules row this suite creates is tracked and archived
  // in afterAll -- this suite must never leave QA pricing fixtures
  // behind that could distort a real club's live "price now" cards.
  const createdRuleIds: string[] = []
  const createdBookingIds: string[] = []

  // Fixed far-future date, isolated from any real recurring day-of-week
  // rule the QA club might already have, and always used with
  // date_specific rules so it never collides with production data.
  const D4_DATE = '2027-03-15' // a Monday, arbitrary far-future QA date

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

    const phone = `+2015558${Date.now().toString().slice(-5)}`
    const customer = await client.rpc('upsert_customer', { p_club_id: clubId, p_full_name: 'D4 Pricing Test Customer', p_phone_e164: phone })
    if (customer.error) throw new Error(`Failed to create test customer: ${customer.error.message}`)
    customerId = customer.data?.[0]?.customer_id

    // The two adjacent pricing windows from the approved policy's own
    // worked example: 100 EGP/hr 08:00-12:00, 150 EGP/hr 12:00-18:00 --
    // both date-specific to D4_DATE so this suite never depends on
    // (or disturbs) the QA club's real recurring day-of-week rules.
    const rules = await client.rpc('create_field_pricing_rules', {
      p_field_id: fieldId,
      p_reason: 'D4_IT_TEST fixtures',
      p_rules: [
        { day_of_week: null, date_specific: D4_DATE, start_time: '08:00', end_time: '12:00', price_per_hour: 100, priority: 10 },
        { day_of_week: null, date_specific: D4_DATE, start_time: '12:00', end_time: '18:00', price_per_hour: 150, priority: 10 },
      ],
    })
    if (rules.error) throw new Error(`Failed to create D4 pricing fixtures: ${rules.error.message}`)
    for (const r of rules.data ?? []) createdRuleIds.push(r.id as string)
  })

  afterAll(async () => {
    for (const bookingId of createdBookingIds) {
      const { data: booking } = await client.from('bookings').select('invoice_id').eq('id', bookingId).maybeSingle()
      const invoiceId = booking?.invoice_id as string | undefined
      if (invoiceId) {
        await client.from('invoice_items').delete().eq('invoice_id', invoiceId)
      }
      await client.from('bookings').delete().eq('id', bookingId)
      if (invoiceId) await client.from('invoices').delete().eq('id', invoiceId)
    }
    await client.from('payments').delete().eq('customer_id', customerId)
    if (createdRuleIds.length > 0) {
      await client.rpc('archive_field_pricing_rules', { p_field_id: fieldId, p_reason: 'D4_IT_TEST cleanup', p_rule_ids: createdRuleIds })
    }
  })

  it('booking entirely inside one pricing window prices as a single segment', async () => {
    const { data, error } = await client.rpc('resolve_field_price_total', {
      p_field_id: fieldId, p_date: D4_DATE, p_start_time: '09:00', p_end_time: '11:00',
    })
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(Number(data![0].price_per_hour)).toBe(100)
    expect(Number(data![0].segment_total)).toBe(200)
  })

  it('booking crossing two adjacent windows matches the approved policy\'s own worked example: 11:00-13:00 = 250 EGP', async () => {
    const { data, error } = await client.rpc('resolve_field_price_total', {
      p_field_id: fieldId, p_date: D4_DATE, p_start_time: '11:00', p_end_time: '13:00',
    })
    expect(error).toBeNull()
    expect(data).toHaveLength(2)
    const total = (data ?? []).reduce((sum: number, row: { segment_total: number }) => sum + Number(row.segment_total), 0)
    expect(total).toBe(250) // (11:00-12:00 @ 100) + (12:00-13:00 @ 150)
  })

  it('booking crossing three windows sums all three segments correctly', async () => {
    // Temporary third window for this test only: 18:00-20:00 @ 200/hr.
    const third = await client.rpc('create_field_pricing_rules', {
      p_field_id: fieldId, p_reason: 'D4_IT_TEST third window',
      p_rules: [{ day_of_week: null, date_specific: D4_DATE, start_time: '18:00', end_time: '20:00', price_per_hour: 200, priority: 10 }],
    })
    expect(third.error).toBeNull()
    const thirdRuleId = third.data?.[0]?.id as string
    createdRuleIds.push(thirdRuleId)

    const { data, error } = await client.rpc('resolve_field_price_total', {
      p_field_id: fieldId, p_date: D4_DATE, p_start_time: '11:00', p_end_time: '19:00',
    })
    expect(error).toBeNull()
    expect(data).toHaveLength(3)
    const total = (data ?? []).reduce((sum: number, row: { segment_total: number }) => sum + Number(row.segment_total), 0)
    // (11-12 @100=100) + (12-18 @150=900) + (18-19 @200=200) = 1200
    expect(total).toBe(1200)
  })

  it('a booking starting exactly at a boundary prices only from that boundary forward', async () => {
    const { data, error } = await client.rpc('resolve_field_price_total', {
      p_field_id: fieldId, p_date: D4_DATE, p_start_time: '12:00', p_end_time: '14:00',
    })
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(Number(data![0].price_per_hour)).toBe(150)
    expect(Number(data![0].segment_total)).toBe(300)
  })

  it('a booking ending exactly at a boundary prices only up to that boundary', async () => {
    const { data, error } = await client.rpc('resolve_field_price_total', {
      p_field_id: fieldId, p_date: D4_DATE, p_start_time: '10:00', p_end_time: '12:00',
    })
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(Number(data![0].price_per_hour)).toBe(100)
    expect(Number(data![0].segment_total)).toBe(200)
  })

  it('an uncovered gap between windows is rejected with a clear error, never silently priced', async () => {
    // 20:00-22:00 has no pricing rule at all on D4_DATE (only 08:00-18:00
    // is covered by the beforeAll fixtures).
    const { data, error } = await client.rpc('resolve_field_price_total', {
      p_field_id: fieldId, p_date: D4_DATE, p_start_time: '20:00', p_end_time: '22:00',
    })
    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect(error?.message).toMatch(/no pricing rule/i)
  })

  it('a booking partially inside a gap (crossing from a covered window into an uncovered one) is fully rejected, not partially priced', async () => {
    const { data, error } = await client.rpc('resolve_field_price_total', {
      p_field_id: fieldId, p_date: D4_DATE, p_start_time: '17:00', p_end_time: '19:00',
    })
    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect(error?.message).toMatch(/no pricing rule/i)
  })

  it('overlapping rules resolve by precedence and are never double-charged', async () => {
    // A higher-priority override for 09:00-10:00 @ 500/hr, overlapping
    // the base 08:00-12:00 @ 100/hr rule from beforeAll.
    const override = await client.rpc('create_field_pricing_rules', {
      p_field_id: fieldId, p_reason: 'D4_IT_TEST precedence override',
      p_rules: [{ day_of_week: null, date_specific: D4_DATE, start_time: '09:00', end_time: '10:00', price_per_hour: 500, priority: 20 }],
    })
    expect(override.error).toBeNull()
    const overrideId = override.data?.[0]?.id as string
    createdRuleIds.push(overrideId)

    const { data, error } = await client.rpc('resolve_field_price_total', {
      p_field_id: fieldId, p_date: D4_DATE, p_start_time: '08:00', p_end_time: '11:00',
    })
    expect(error).toBeNull()
    // Must split into exactly 3 segments (08-09 base, 09-10 override, 10-11 base)
    // -- never 2 segments (which would mean the overlap was ignored) and
    // never overlapping/duplicated segments (which would double-charge).
    expect(data).toHaveLength(3)
    const total = (data ?? []).reduce((sum: number, row: { segment_total: number }) => sum + Number(row.segment_total), 0)
    // (08-09 @100=100) + (09-10 @500=500) + (10-11 @100=100) = 700
    expect(total).toBe(700)
    const overrideSegment = (data ?? []).find((row: { segment_start: string }) => row.segment_start === '09:00:00')
    expect(Number(overrideSegment?.price_per_hour)).toBe(500)
  })

  it('a date-specific rule takes precedence over a recurring day-of-week rule for the same slot', async () => {
    // D4_DATE (2027-03-15) is a Monday -- day_of_week 1. Add a low-price
    // recurring Monday rule that would otherwise cover 08:00-09:00; the
    // existing date-specific 100 EGP/hr rule must still win.
    const recurring = await client.rpc('create_field_pricing_rules', {
      p_field_id: fieldId, p_reason: 'D4_IT_TEST recurring-vs-date-specific',
      p_rules: [{ day_of_week: 1, date_specific: null, start_time: '08:00', end_time: '09:00', price_per_hour: 10, priority: 10 }],
    })
    expect(recurring.error).toBeNull()
    const recurringId = recurring.data?.[0]?.id as string
    createdRuleIds.push(recurringId)

    const { data, error } = await client.rpc('resolve_field_price_total', {
      p_field_id: fieldId, p_date: D4_DATE, p_start_time: '08:00', p_end_time: '09:00',
    })
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    // Must still be the date-specific 100 EGP/hr rule, not the 10 EGP/hr recurring one.
    expect(Number(data![0].price_per_hour)).toBe(100)
  })

  it('a real booking spanning two pricing windows is charged the exact segmented total end-to-end, and its invoice reconciles', async () => {
    const startAt = new Date(`${D4_DATE}T11:00:00Z`).toISOString()
    const endAt = new Date(`${D4_DATE}T13:00:00Z`).toISOString()
    const booking = await client.rpc('create_booking', {
      p_field_id: fieldId, p_customer_id: customerId, p_start_at: startAt, p_end_at: endAt, p_notes: 'D4_IT_TEST straddle booking',
    })
    expect(booking.error).toBeNull()
    const bookingId = booking.data as string
    createdBookingIds.push(bookingId)

    const { data: row } = await client.from('bookings').select('invoice_id, total_price').eq('id', bookingId).single()
    // The exact number from the approved policy's own worked example --
    // regardless of which UTC offset the club's timezone puts this slot
    // at, the booking's total must reconcile with resolve_field_price_total.
    const invoiceId = row!.invoice_id as string
    const { data: invoiceRow } = await client.from('invoices').select('total').eq('id', invoiceId).single()
    expect(Number(invoiceRow!.total)).toBe(Number(row!.total_price))

    const { data: items } = await client.from('invoice_items').select('line_total').eq('invoice_id', invoiceId)
    const itemsTotal = (items ?? []).reduce((sum, i) => sum + Number(i.line_total), 0)
    expect(itemsTotal).toBe(Number(row!.total_price))
  })

  it('rescheduling a booking into a different pricing window recalculates via the segmented engine', async () => {
    const startAt = new Date(`${D4_DATE}T09:00:00Z`).toISOString()
    const endAt = new Date(`${D4_DATE}T10:00:00Z`).toISOString()
    const booking = await client.rpc('create_booking', {
      p_field_id: fieldId, p_customer_id: customerId, p_start_at: startAt, p_end_at: endAt, p_notes: 'D4_IT_TEST reschedule source',
    })
    expect(booking.error).toBeNull()
    const bookingId = booking.data as string
    createdBookingIds.push(bookingId)

    const { data: before } = await client.from('bookings').select('total_price').eq('id', bookingId).single()
    expect(Number(before!.total_price)).toBe(100) // 1hr @ 100 EGP/hr

    // Reschedule to a straddling slot, same day: 11:00-13:00.
    const newStart = new Date(`${D4_DATE}T11:00:00Z`).toISOString()
    const newEnd = new Date(`${D4_DATE}T13:00:00Z`).toISOString()
    const reschedule = await client.rpc('reschedule_booking', { p_booking_id: bookingId, p_new_start_at: newStart, p_new_end_at: newEnd })
    expect(reschedule.error).toBeNull()

    const { data: after } = await client.from('bookings').select('total_price').eq('id', bookingId).single()
    expect(Number(after!.total_price)).toBe(250) // matches the approved worked example
  })

  it('editing a pricing rule after a booking is made does not change that booking\'s already-recorded historical price', async () => {
    const startAt = new Date(`${D4_DATE}T09:00:00Z`).toISOString()
    const endAt = new Date(`${D4_DATE}T10:00:00Z`).toISOString()
    const booking = await client.rpc('create_booking', {
      p_field_id: fieldId, p_customer_id: customerId, p_start_at: startAt, p_end_at: endAt, p_notes: 'D4_IT_TEST historical immutability',
    })
    expect(booking.error).toBeNull()
    const bookingId = booking.data as string
    createdBookingIds.push(bookingId)

    const { data: before } = await client.from('bookings').select('total_price').eq('id', bookingId).single()
    expect(Number(before!.total_price)).toBe(100)

    // Replace the 08:00-12:00 @ 100 rule with a 08:00-12:00 @ 999 rule --
    // archive the old one, create a new one, matching PricingEditor's own
    // edit flow (archive + recreate, never a raw UPDATE of a live rule).
    const originalRuleId = createdRuleIds[0]!
    const archiveThenEdit = await client.rpc('archive_field_pricing_rules', {
      p_field_id: fieldId, p_reason: 'D4_IT_TEST simulate a price edit', p_rule_ids: [originalRuleId],
    })
    expect(archiveThenEdit.error).toBeNull()
    createdRuleIds.splice(createdRuleIds.indexOf(originalRuleId), 1)

    const replacement = await client.rpc('create_field_pricing_rules', {
      p_field_id: fieldId, p_reason: 'D4_IT_TEST simulate a price edit (replacement)',
      p_rules: [{ day_of_week: null, date_specific: D4_DATE, start_time: '08:00', end_time: '12:00', price_per_hour: 999, priority: 10 }],
    })
    expect(replacement.error).toBeNull()
    createdRuleIds.push(replacement.data?.[0]?.id as string)

    // The already-created booking's stored total_price must be untouched.
    const { data: after } = await client.from('bookings').select('total_price').eq('id', bookingId).single()
    expect(Number(after!.total_price)).toBe(100)

    // But a NEW booking against the same (now-edited) window prices at the new rate.
    const newBooking = await client.rpc('create_booking', {
      p_field_id: fieldId, p_customer_id: customerId,
      p_start_at: new Date(`${D4_DATE}T09:00:00Z`).toISOString(),
      p_end_at: new Date(`${D4_DATE}T10:00:00Z`).toISOString(),
      p_notes: 'D4_IT_TEST post-edit booking',
    })
    expect(newBooking.error).toBeNull()
    createdBookingIds.push(newBooking.data as string)
    const { data: newRow } = await client.from('bookings').select('total_price').eq('id', newBooking.data as string).single()
    expect(Number(newRow!.total_price)).toBe(999)
  })

  it('two concurrent booking attempts for the same straddling slot both resolve the same segmented price, and only one wins the slot', async () => {
    const startAt = new Date(`${D4_DATE}T11:00:00Z`).toISOString()
    const endAt = new Date(`${D4_DATE}T13:00:00Z`).toISOString()
    const [a, b] = await Promise.all([
      client.rpc('create_booking', { p_field_id: fieldId, p_customer_id: customerId, p_start_at: startAt, p_end_at: endAt, p_notes: 'D4_IT_TEST concurrent A' }),
      client.rpc('create_booking', { p_field_id: fieldId, p_customer_id: customerId, p_start_at: startAt, p_end_at: endAt, p_notes: 'D4_IT_TEST concurrent B' }),
    ])
    const results = [a, b]
    const succeeded = results.filter((r) => !r.error)
    const failed = results.filter((r) => r.error)
    expect(succeeded).toHaveLength(1)
    expect(failed).toHaveLength(1)
    const winnerId = succeeded[0]!.data as string
    createdBookingIds.push(winnerId)
    const { data: row } = await client.from('bookings').select('total_price').eq('id', winnerId).single()
    expect(Number(row!.total_price)).toBe(250) // the winner still got the correct segmented price
  })
})

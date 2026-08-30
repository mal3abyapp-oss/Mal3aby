import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// PRINTING PRODUCTION ACCEPTANCE (2026-08-30) -- regression guard for D7+D8:
//
// D7: sell_club_membership()/renew_club_membership() previously inserted the
// invoice_items.description as a bare plan name with no validity/expiry date
// range, even though the correct v_end_date (and, for renewals,
// v_effective_start) was already computed right above the insert. Fixed to
// append the start->end date range.
//
// D8: that date range then rendered VISUALLY REVERSED on the actual printed
// invoice (an LTR date range embedded in Arabic prose inside an RTL table
// cell, with no directional isolation -- the same bug class as commit
// f0cbb0a's operating-hours reversal). Fixed by wrapping the date range in
// Unicode FSI (U+2068) / PDI (U+2069) directional-isolation characters.
//
// This suite follows the SAME established convention as the other
// *.integration.test.ts files in this codebase (see
// invoice-drilldown-navigation.integration.test.ts): no component-render
// test tooling is installed, so this is a real integration test against the
// live Supabase project's actual RPC contracts (not mocked), using a real
// authenticated session so RLS is genuinely exercised. Configure via env
// (reuses the same QA credential as the other integration suites):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
//   CUSTOMER_360_TEST_EMAIL, CUSTOMER_360_TEST_PASSWORD
// Skips cleanly (not a failure) when these aren't configured.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const TEST_EMAIL = import.meta.env.CUSTOMER_360_TEST_EMAIL as string | undefined
const TEST_PASSWORD = import.meta.env.CUSTOMER_360_TEST_PASSWORD as string | undefined

const canRun = !!(SUPABASE_URL && SUPABASE_ANON_KEY && TEST_EMAIL && TEST_PASSWORD)
const describeIfConfigured = canRun ? describe : describe.skip

const FSI = '⁨'
const PDI = '⁩'

describeIfConfigured('Club membership invoice line description (live integration)', () => {
  let client: SupabaseClient
  let clubId: string
  let branchId: string
  let planId: string
  let createdCustomerIds: string[] = []

  beforeAll(async () => {
    client = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!)
    const { data, error } = await client.auth.signInWithPassword({ email: TEST_EMAIL!, password: TEST_PASSWORD! })
    if (error || !data.session) throw new Error(`Test account sign-in failed: ${error?.message}`)

    const { data: clubIds, error: clubErr } = await client.rpc('user_club_ids')
    if (clubErr || !clubIds || clubIds.length === 0) throw new Error(`Could not resolve a club for the test account: ${clubErr?.message}`)
    clubId = clubIds[0]

    const { data: plan, error: planErr } = await client
      .from('club_membership_plans')
      .select('id, price')
      .eq('club_id', clubId)
      .is('archived_at', null)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle()
    if (planErr || !plan) throw new Error(`No active club membership plan available for the test club: ${planErr?.message}`)
    planId = plan.id

    const { data: branch, error: branchErr } = await client.from('branches').select('id').eq('club_id', clubId).limit(1).maybeSingle()
    if (branchErr || !branch) throw new Error(`No branch available for the test club: ${branchErr?.message}`)
    branchId = branch.id
  })

  afterAll(async () => {
    // Disposable QA fixtures only (directive Section 24) -- never touches
    // real financial history. Subscriptions/invoices created by the sale
    // RPC are left in place (immutable financial records), matching the
    // existing convention in this codebase's other integration suites.
    for (const id of createdCustomerIds) {
      await client.from('customers').delete().eq('id', id).eq('club_id', clubId)
    }
  })

  it('sell_club_membership() writes a date-range description wrapped in bidi isolation, matching the persisted dates', async () => {
    const { data: customer, error: customerErr } = await client
      .from('customers')
      .insert({ club_id: clubId, full_name: 'Integration Test — Membership Description', mobile_display: '0100000' + Math.floor(Math.random() * 9000 + 1000), normalized_mobile: '2010000' + Math.floor(Math.random() * 900000 + 100000) })
      .select('id')
      .single()
    if (customerErr || !customer) throw new Error(`Could not create a disposable QA customer: ${customerErr?.message}`)
    createdCustomerIds.push(customer.id)

    const startDate = new Date().toISOString().slice(0, 10)
    const { data: sale, error: saleErr } = await client.rpc('sell_club_membership', {
      p_club_id: clubId,
      p_customer_id: customer.id,
      p_plan_id: planId,
      p_branch_id: branchId,
      p_start_date: startDate,
      p_discount: 0,
      p_idempotency_key: crypto.randomUUID(),
    })
    if (saleErr || !sale) throw new Error(`sell_club_membership failed: ${saleErr?.message}`)

    const invoiceId = Array.isArray(sale) ? sale[0].invoice_id : sale.invoice_id
    const subscriptionId = Array.isArray(sale) ? sale[0].membership_subscription_id : sale.membership_subscription_id

    const { data: sub, error: subErr } = await client
      .from('club_membership_subscriptions')
      .select('start_date, end_date')
      .eq('id', subscriptionId)
      .single()
    if (subErr || !sub) throw new Error(`Could not read back the created subscription: ${subErr?.message}`)

    const { data: item, error: itemErr } = await client
      .from('invoice_items')
      .select('description')
      .eq('invoice_id', invoiceId)
      .single()
    if (itemErr || !item) throw new Error(`Could not read back the invoice item: ${itemErr?.message}`)

    // D7: the description must contain the actual persisted start/end dates,
    // not a bare plan name with no date range.
    expect(item.description).toContain(sub.start_date)
    expect(item.description).toContain(sub.end_date)

    // D8: the date range must be wrapped in FSI...PDI so it renders as an
    // isolated LTR run and does not get visually reordered by the bidi
    // algorithm when embedded in RTL Arabic prose. A regression here (e.g.
    // someone "cleaning up" the seemingly-invisible isolation characters)
    // would reintroduce the visual date reversal bug without any test
    // failure elsewhere, since innerText/DOM order is unaffected -- only
    // the bidi rendering is.
    expect(item.description).toContain(FSI)
    expect(item.description).toContain(PDI)
    expect(item.description.indexOf(FSI)).toBeLessThan(item.description.indexOf(sub.start_date))
    expect(item.description.indexOf(PDI)).toBeGreaterThan(item.description.indexOf(sub.end_date))
  })
})

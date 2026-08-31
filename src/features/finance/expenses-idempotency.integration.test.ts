import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// STAFF OPERATIONS PRODUCTION ACCEPTANCE (2026-08-31) Section 39
// (double-click/retry safety) -- dedicated regression coverage for the
// record_expense() idempotency gap: this RPC had NO server-side dedup
// mechanism at all before this fix, unlike every other financial-
// commitment RPC (record_payment, create_refund). A double-click, or a
// client retry after a dropped response, would previously insert two
// separate expense rows for the same logical submission -- silently
// corrupting the cash-drawer reconciliation invariant this directive
// explicitly requires (EXPECTED CASH DRAWER = SYSTEM EXPECTED DRAWER).
//
// See supabase/migrations/20260831073301_expenses_idempotency_key.sql,
// 20260831073342_drop_record_expense_old_overload.sql, and
// 20260831073410_fix_record_expense_grant_leak.sql for the full fix
// (added the column + unique index, re-created the RPC with
// p_idempotency_key, dropped the orphaned 9-arg overload the
// CREATE OR REPLACE left behind, and re-applied the original
// authenticated-only grant that a brand-new function signature does
// NOT inherit from its predecessor by default in Postgres).
//
// Real integration test against the live Supabase project (not
// mocked), following the exact same pattern as every other
// *.integration.test.ts in this repo. Needs a real QA staff account
// with expense.create on at least one club with at least one branch.
// Configure via env:
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

describeIfConfigured('record_expense idempotency (live integration)', () => {
  let client: SupabaseClient
  let clubId: string
  let branchId: string
  const createdExpenseIds: string[] = []

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
  })

  afterAll(async () => {
    // Expenses have no hard-delete RPC (void only, by design -- see
    // Section 20 "no hard deletion of historical expense records").
    // These are disposable QA fixtures with a distinguishing
    // description prefix; void them rather than leaving live
    // 'recorded' rows in the QA club's real expense ledger.
    for (const id of createdExpenseIds) {
      await client.rpc('void_expense', { p_expense_id: id, p_reason: 'expenses-idempotency.integration.test.ts cleanup' })
    }
  })

  it('a duplicate call with the SAME idempotency key returns the SAME expense id, not a new row', async () => {
    const idempotencyKey = crypto.randomUUID()

    const first = await client.rpc('record_expense', {
      p_club_id: clubId,
      p_branch_id: branchId,
      p_amount: 42.5,
      p_payment_method: 'bank_transfer',
      p_description: 'EXPENSES_IDEMPOTENCY_IT_TEST duplicate-key check',
      p_idempotency_key: idempotencyKey,
    })
    expect(first.error).toBeNull()
    const firstId = first.data as string
    createdExpenseIds.push(firstId)

    const second = await client.rpc('record_expense', {
      p_club_id: clubId,
      p_branch_id: branchId,
      p_amount: 42.5,
      p_payment_method: 'bank_transfer',
      p_description: 'EXPENSES_IDEMPOTENCY_IT_TEST duplicate-key check',
      p_idempotency_key: idempotencyKey,
    })
    expect(second.error).toBeNull()
    expect(second.data).toBe(firstId) // same row returned, not a new insert

    const { data: rows, error: countErr } = await client
      .from('expenses')
      .select('id')
      .eq('idempotency_key', idempotencyKey)
    expect(countErr).toBeNull()
    expect(rows).toHaveLength(1) // exactly one row was ever inserted for this key
  })

  it('two DIFFERENT idempotency keys correctly create two separate expense rows (proves the fix does not over-dedupe)', async () => {
    const first = await client.rpc('record_expense', {
      p_club_id: clubId,
      p_branch_id: branchId,
      p_amount: 10,
      p_payment_method: 'card',
      p_description: 'EXPENSES_IDEMPOTENCY_IT_TEST distinct-key A',
      p_idempotency_key: crypto.randomUUID(),
    })
    expect(first.error).toBeNull()
    createdExpenseIds.push(first.data as string)

    const second = await client.rpc('record_expense', {
      p_club_id: clubId,
      p_branch_id: branchId,
      p_amount: 10,
      p_payment_method: 'card',
      p_description: 'EXPENSES_IDEMPOTENCY_IT_TEST distinct-key B',
      p_idempotency_key: crypto.randomUUID(),
    })
    expect(second.error).toBeNull()
    createdExpenseIds.push(second.data as string)

    expect(second.data).not.toBe(first.data)
  })

  it('the old 9-arg overload (no idempotency key) no longer exists -- callers cannot bypass the dedup path', async () => {
    // PostgREST resolves supabase.rpc() calls by matching the provided
    // argument names against a function's signature -- omitting
    // p_idempotency_key entirely should still resolve to the SAME
    // (now sole) 10-arg function with p_idempotency_key defaulting to
    // null, not fail and not silently hit a stale duplicate overload.
    const result = await client.rpc('record_expense', {
      p_club_id: clubId,
      p_branch_id: branchId,
      p_amount: 5,
      p_payment_method: 'other',
      p_description: 'EXPENSES_IDEMPOTENCY_IT_TEST no-key-omitted call',
    })
    expect(result.error).toBeNull()
    createdExpenseIds.push(result.data as string)
  })
})

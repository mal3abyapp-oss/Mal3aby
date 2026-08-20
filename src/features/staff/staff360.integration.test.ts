import { describe, it, expect, beforeAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Staff 360 directive section 104: dedicated automated tests for every
// invariant, not trivial formatting tests. Every rule below was already
// proven live during this engagement (direct authenticated-session SQL
// via `SET LOCAL role authenticated; SET LOCAL request.jwt.claims`,
// mirroring exactly what PostgREST does for a real logged-in user) --
// this file turns those into a repeatable, CI-runnable suite against
// the real RPCs, following the same live-integration pattern as
// customer360.integration.test.ts.
//
// This is a real integration test against the live Supabase project
// (not mocked, not jsdom-simulated) -- it needs a genuine QA staff
// account's credentials to authenticate as a real user, exactly as the
// RPCs' own has_permission()/user_club_ids() authorization checks
// require. Configure via env:
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (already required by the
//     app itself, see .env.example)
//   STAFF_360_OWNER_EMAIL, STAFF_360_OWNER_PASSWORD -- a club_owner (or
//     equivalent) account with payment.create/payment.refund and
//     staff.update on the QA club -- never a service_role key.
//   STAFF_360_EMPLOYEE_EMAIL, STAFF_360_EMPLOYEE_PASSWORD -- a
//     cash-custody employee account (e.g. receptionist) in the SAME
//     club, used only to prove the self-settlement/self-reversal block
//     and the suspended-session-enforcement test.
// Skips cleanly (not a failure) when these aren't configured, so a CI
// run without secrets doesn't red the build; run locally or in an
// environment with the QA credentials to actually execute it.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const OWNER_EMAIL = import.meta.env.STAFF_360_OWNER_EMAIL as string | undefined
const OWNER_PASSWORD = import.meta.env.STAFF_360_OWNER_PASSWORD as string | undefined
const EMPLOYEE_EMAIL = import.meta.env.STAFF_360_EMPLOYEE_EMAIL as string | undefined
const EMPLOYEE_PASSWORD = import.meta.env.STAFF_360_EMPLOYEE_PASSWORD as string | undefined

const canRun = !!(SUPABASE_URL && SUPABASE_ANON_KEY && OWNER_EMAIL && OWNER_PASSWORD && EMPLOYEE_EMAIL && EMPLOYEE_PASSWORD)
const describeIfConfigured = canRun ? describe : describe.skip

describeIfConfigured('Staff 360 invariants (live integration)', () => {
  let owner: SupabaseClient
  let employee: SupabaseClient
  let clubId: string
  let employeeMembershipId: string
  let branchId: string

  beforeAll(async () => {
    owner = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!)
    employee = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!)

    const ownerSignIn = await owner.auth.signInWithPassword({ email: OWNER_EMAIL!, password: OWNER_PASSWORD! })
    if (ownerSignIn.error || !ownerSignIn.data.session) throw new Error(`Owner sign-in failed: ${ownerSignIn.error?.message}`)
    const employeeSignIn = await employee.auth.signInWithPassword({ email: EMPLOYEE_EMAIL!, password: EMPLOYEE_PASSWORD! })
    if (employeeSignIn.error || !employeeSignIn.data.session) throw new Error(`Employee sign-in failed: ${employeeSignIn.error?.message}`)

    const { data: clubIds, error: clubErr } = await owner.rpc('user_club_ids')
    if (clubErr || !clubIds || clubIds.length === 0) throw new Error('Owner account has no club membership')
    clubId = clubIds[0] as string

    const { data: membership, error: membershipErr } = await employee
      .from('club_memberships')
      .select('id')
      .eq('club_id', clubId)
      .single()
    if (membershipErr || !membership) throw new Error('Employee account has no membership in the owner club')
    employeeMembershipId = membership.id as string

    const { data: branches, error: branchErr } = await owner.from('branches').select('id').eq('club_id', clubId).limit(1)
    if (branchErr || !branches || branches.length === 0) throw new Error('Club has no branches configured')
    branchId = branches[0]!.id as string
  })

  async function openShift(client: SupabaseClient, opening: number) {
    const { data, error } = await client.rpc('open_cash_shift', { p_club_id: clubId, p_branch_id: branchId, p_opening_float: opening })
    if (error) throw error
    return data as string
  }

  async function closeShiftWithShortage(client: SupabaseClient, shiftId: string, counted: number) {
    const { data, error } = await client.rpc('close_cash_shift', { p_shift_id: shiftId, p_closing_count: counted, p_notes: 'staff360 integration test' })
    if (error) throw error
    return data as { variance: number; liability_id: string | null; expected_cash: number; closing_count: number }
  }

  // Directive rule #9: shortage creates a liability; rule #26 worked
  // example (Expected 1000, Counted 900 -> Shortage 100 -> Liability 100).
  it('creates a shortage liability with the correct variance when counted cash is below expected', async () => {
    const shiftId = await openShift(employee, 500)
    const result = await closeShiftWithShortage(employee, shiftId, 400)
    expect(result.variance).toBe(-100)
    expect(result.liability_id).toBeTruthy()

    const { data: liability, error } = await owner
      .from('employee_cash_liabilities')
      .select('kind, original_amount, outstanding, status, cash_shift_id')
      .eq('id', result.liability_id!)
      .single()
    expect(error).toBeNull()
    expect(liability!.kind).toBe('shortage')
    expect(Number(liability!.original_amount)).toBe(100)
    expect(Number(liability!.outstanding)).toBe(100)
    expect(liability!.status).toBe('outstanding')
    expect(liability!.cash_shift_id).toBe(shiftId)

    // cleanup: reverse rather than raw-delete financial history (rule #80)
    await owner.rpc('reverse_employee_cash_liability', { p_liability_id: result.liability_id!, p_reason: 'integration test cleanup' })
  })

  // Directive rule #103/#26: overage does NOT create an employee liability.
  it('does not create a liability when counted cash exceeds expected (overage)', async () => {
    const shiftId = await openShift(employee, 1000)
    const result = await closeShiftWithShortage(employee, shiftId, 1100)
    expect(result.variance).toBe(100)
    expect(result.liability_id).toBeNull()
  })

  // Directive rule #22: one open shift per applicable scope -- opening
  // a second shift for the same branch while one is open must fail.
  it('rejects opening a second shift for a branch that already has one open', async () => {
    const shiftId = await openShift(employee, 200)
    const second = await employee.rpc('open_cash_shift', { p_club_id: clubId, p_branch_id: branchId, p_opening_float: 100 })
    expect(second.error).not.toBeNull()
    // cleanup
    await employee.rpc('close_cash_shift', { p_shift_id: shiftId, p_closing_count: 200, p_notes: 'cleanup' })
  })

  // Directive rule #10/#47: an employee can never settle their own liability.
  it('rejects an employee settling their own liability', async () => {
    const shiftId = await openShift(employee, 500)
    const result = await closeShiftWithShortage(employee, shiftId, 400)
    expect(result.liability_id).toBeTruthy()

    const selfSettle = await employee.rpc('settle_employee_cash_liability', {
      p_liability_id: result.liability_id!, p_amount: 50, p_reason: 'self attempt', p_idempotency_key: `test-self-${Date.now()}`,
    })
    expect(selfSettle.error).not.toBeNull()

    await owner.rpc('reverse_employee_cash_liability', { p_liability_id: result.liability_id!, p_reason: 'integration test cleanup' })
  })

  // Directive rule #10/#47 (reversal side) -- same block applies to reversal.
  it('rejects an employee reversing their own liability', async () => {
    const shiftId = await openShift(employee, 500)
    const result = await closeShiftWithShortage(employee, shiftId, 450)
    expect(result.liability_id).toBeTruthy()

    const selfReverse = await employee.rpc('reverse_employee_cash_liability', { p_liability_id: result.liability_id!, p_reason: 'self attempt' })
    expect(selfReverse.error).not.toBeNull()

    await owner.rpc('reverse_employee_cash_liability', { p_liability_id: result.liability_id!, p_reason: 'integration test cleanup' })
  })

  // Directive rule #39/#40: partial then full settlement math.
  it('supports partial settlement followed by full settlement to zero outstanding', async () => {
    const shiftId = await openShift(employee, 500)
    const result = await closeShiftWithShortage(employee, shiftId, 400)
    const liabilityId = result.liability_id!

    const partial = await owner.rpc('settle_employee_cash_liability', {
      p_liability_id: liabilityId, p_amount: 40, p_reason: 'partial', p_idempotency_key: `test-partial-${Date.now()}`,
    })
    expect(partial.error).toBeNull()
    expect(partial.data.outstanding).toBe(60)
    expect(partial.data.status).toBe('outstanding')

    const full = await owner.rpc('settle_employee_cash_liability', {
      p_liability_id: liabilityId, p_amount: 60, p_reason: 'final', p_idempotency_key: `test-final-${Date.now()}`,
    })
    expect(full.error).toBeNull()
    expect(full.data.outstanding).toBe(0)
    expect(full.data.status).toBe('settled')
  })

  // Directive rule #6/#41: over-settlement must hard fail, never create a credit.
  it('rejects a settlement amount greater than the outstanding balance', async () => {
    const shiftId = await openShift(employee, 200)
    const result = await closeShiftWithShortage(employee, shiftId, 100)
    const liabilityId = result.liability_id!

    const overSettle = await owner.rpc('settle_employee_cash_liability', {
      p_liability_id: liabilityId, p_amount: 999, p_reason: 'over-settlement attempt', p_idempotency_key: `test-over-${Date.now()}`,
    })
    expect(overSettle.error).not.toBeNull()

    await owner.rpc('reverse_employee_cash_liability', { p_liability_id: liabilityId, p_reason: 'integration test cleanup' })
  })

  // Directive rule #8/#42/#90: settlement retry/double-click must never
  // create a duplicate settlement -- same idempotency key applied twice
  // must resolve to exactly one ledger entry.
  it('does not apply a duplicate settlement when the same idempotency key is retried', async () => {
    const shiftId = await openShift(employee, 500)
    const result = await closeShiftWithShortage(employee, shiftId, 400)
    const liabilityId = result.liability_id!
    const idempotencyKey = `test-idem-${Date.now()}`

    const first = await owner.rpc('settle_employee_cash_liability', { p_liability_id: liabilityId, p_amount: 60, p_reason: 'idempotency test', p_idempotency_key: idempotencyKey })
    expect(first.error).toBeNull()
    expect(first.data.outstanding).toBe(40)

    const retry = await owner.rpc('settle_employee_cash_liability', { p_liability_id: liabilityId, p_amount: 60, p_reason: 'idempotency test', p_idempotency_key: idempotencyKey })
    expect(retry.error).toBeNull()

    const { data: liability, error } = await owner.from('employee_cash_liabilities').select('outstanding').eq('id', liabilityId).single()
    expect(error).toBeNull()
    expect(Number(liability!.outstanding)).toBe(40)

    const { count } = await owner
      .from('employee_cash_liability_ledger')
      .select('id', { count: 'exact', head: true })
      .eq('liability_id', liabilityId)
      .eq('entry_type', 'settlement')
    expect(count).toBe(1)

    await owner.rpc('reverse_employee_cash_liability', { p_liability_id: liabilityId, p_reason: 'integration test cleanup' })
  })

  // Directive rule #2/#34: original liability amount stays fixed
  // through settlement and reversal -- never edited in place.
  it('keeps the original liability amount immutable through settlement', async () => {
    const shiftId = await openShift(employee, 500)
    const result = await closeShiftWithShortage(employee, shiftId, 400)
    const liabilityId = result.liability_id!

    await owner.rpc('settle_employee_cash_liability', { p_liability_id: liabilityId, p_amount: 30, p_reason: 'partial', p_idempotency_key: `test-immutable-${Date.now()}` })

    const { data: liability, error } = await owner.from('employee_cash_liabilities').select('original_amount').eq('id', liabilityId).single()
    expect(error).toBeNull()
    expect(Number(liability!.original_amount)).toBe(100)

    await owner.rpc('reverse_employee_cash_liability', { p_liability_id: liabilityId, p_reason: 'integration test cleanup' })
  })

  // Directive rule #17/#97: custody OFF must hard-fail while a shift is open.
  it('rejects turning off cash custody while the employee has an open shift', async () => {
    const shiftId = await openShift(employee, 100)
    const result = await owner.rpc('set_staff_cash_custody', { p_membership_id: employeeMembershipId, p_has_custody: false })
    expect(result.error).not.toBeNull()
    await employee.rpc('close_cash_shift', { p_shift_id: shiftId, p_closing_count: 100, p_notes: 'cleanup' })
  })

  // Directive rule #17/#52/#98: suspension must hard-fail while a shift is open.
  it('rejects suspending an employee while they have an open shift', async () => {
    const shiftId = await openShift(employee, 100)
    const result = await owner.rpc('deactivate_staff_member', { p_membership_id: employeeMembershipId })
    expect(result.error).not.toBeNull()
    await employee.rpc('close_cash_shift', { p_shift_id: shiftId, p_closing_count: 100, p_notes: 'cleanup' })
  })

  // Directive rule #16 (suspend after close) + #100 (suspended session
  // enforcement) + #101 (history preserved) -- combined lifecycle test.
  it('allows suspension after shift close, blocks the suspended session, preserves history, and allows reactivation', async () => {
    const result = await owner.rpc('deactivate_staff_member', { p_membership_id: employeeMembershipId })
    expect(result.error).toBeNull()

    // The employee's existing session must now be rejected by a
    // protected RPC -- no session-persistence loophole.
    const blocked = await employee.rpc('open_cash_shift', { p_club_id: clubId, p_branch_id: branchId, p_opening_float: 50 })
    expect(blocked.error).not.toBeNull()

    // History remains visible to an authorized viewer.
    const { count, error: countErr } = await owner
      .from('cash_shifts')
      .select('id', { count: 'exact', head: true })
      .eq('club_id', clubId)
    expect(countErr).toBeNull()
    expect(count).toBeGreaterThan(0)

    const reactivate = await owner.rpc('reactivate_staff_member', { p_membership_id: employeeMembershipId })
    expect(reactivate.error).toBeNull()

    const { data: membership, error: membershipErr } = await owner.from('club_memberships').select('status').eq('id', employeeMembershipId).single()
    expect(membershipErr).toBeNull()
    expect(membership!.status).toBe('active')
  })

  // Directive rule #21: tenant isolation must be proven with a genuine
  // authenticated session against a club the user is not a member of.
  it('rejects Staff 360 RPCs for a club the authenticated user is not a member of', async () => {
    const foreignClubId = '00000000-0000-0000-0000-000000000000'
    const result = await owner.rpc('get_staff_360_summary', { p_club_id: foreignClubId, p_membership_id: employeeMembershipId })
    expect(result.error).not.toBeNull()
  })
})

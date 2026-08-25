// Shared domain types for Phase 3 — Staff & Permissions Management.

export interface StaffRow {
  membershipId: string
  userId: string
  fullName: string | null
  roleKey: string
  roleNameAr: string
  status: string
  branchNames: string[] // empty = all branches (zero rows in membership_branches)
  // Phase D (D1): explicit per-person cash-handling authorization,
  // independent of role.
  hasCashCustody: boolean
  // FINAL PRODUCT COMPLETENESS ROUND (2026-08-25) -- Club Owner
  // persona: "is anything in their custody" needs to be visible from
  // the staff LIST, not only after opening each person's Employee 360
  // page. Sourced from the real, existing employee_cash_liabilities
  // table (status = 'outstanding'), batched in one query for the whole
  // list -- same pattern as this file's own profiles batching, not a
  // per-row RPC call.
  outstandingLiability: number
}

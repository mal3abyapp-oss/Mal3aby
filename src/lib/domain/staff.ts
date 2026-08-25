// Shared domain types for Phase 3 — Staff & Permissions Management.

export interface StaffRow {
  membershipId: string
  userId: string
  fullName: string | null
  roleKey: string
  roleNameAr: string
  // STAFF ACCESS CONTROL & CUSTOM ROLES (2026-08-25): true when this
  // membership's role is a club-owned custom role (roleKey is '' in
  // that case) rather than one of the 9 fixed system roles -- the
  // staff-list role column needs this to render roleNameAr directly
  // instead of looking up a i18n `staff.roles.<key>` translation that
  // will never exist for a club-specific name.
  isCustomRole: boolean
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

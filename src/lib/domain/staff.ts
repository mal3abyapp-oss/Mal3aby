// Shared domain types for Phase 3 — Staff & Permissions Management.

export interface StaffRow {
  membershipId: string
  userId: string
  fullName: string | null
  roleKey: string
  roleNameAr: string
  status: string
  branchNames: string[] // empty = all branches (zero rows in membership_branches)
}

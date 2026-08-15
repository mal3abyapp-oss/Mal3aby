// Shared domain types for the identity/multi-tenant core (Phase 2).
// club_memberships is the RLS anchor table (docs/ARCHITECTURE.md#rls-strategy);
// this shape is what the frontend actually needs after joining roles.

export interface ActiveMembership {
  membershipId: string
  clubId: string
  clubName: string
  clubNameAr: string
  roleKey: string
  roleName: string
  roleNameAr: string
}

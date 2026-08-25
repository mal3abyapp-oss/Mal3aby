// Shared domain types for the identity/multi-tenant core (Phase 2).
// club_memberships is the RLS anchor table (docs/ARCHITECTURE.md#rls-strategy);
// this shape is what the frontend actually needs after joining roles.

// STAFF ACCESS CONTROL & CUSTOM ROLES (2026-08-25): a membership now has
// EITHER a system role (roleKey set) OR a custom club role (roleKey is
// null, customRoleId set) -- never both, mirroring the DB's
// club_memberships_exactly_one_role CHECK constraint exactly. roleName/
// roleNameAr stay populated either way (from roles.name/name_ar for a
// system role, from club_roles.name_en/name_ar for a custom one) so
// every existing display site (club switcher, Employee 360, audit UI)
// keeps working unchanged. permissionKeys is the real, server-computed
// capability set for this membership (via caller_permission_keys()) --
// this is what nav visibility and route guards must key off of now,
// never roleKey alone, since a custom role has no roleKey at all.
export interface ActiveMembership {
  membershipId: string
  clubId: string
  clubName: string
  clubNameAr: string
  roleKey: string | null
  roleName: string
  roleNameAr: string
  customRoleId: string | null
  permissionKeys: string[]
}

// Shared permission-based navigation visibility.
//
// STAFF ACCESS CONTROL & CUSTOM ROLES (2026-08-25): rewritten from a
// hand-maintained roleKey -> nav-domain map to a real permission-key
// derivation. The old map (kept working correctly for the 9 system
// roles throughout its life, see git history) had two structural
// problems this phase's own acceptance test would have caught
// immediately: (1) it could not represent a custom role at all -- a
// custom role has no roleKey, so canSeeNavDomain(undefined, ...)'s
// "unrecognized role -> permissive" fallback made every custom role see
// every nav item regardless of its actual permission set (fail OPEN,
// the exact "hidden button, not real security" pattern this phase
// exists to eliminate); (2) it was a manually-maintained mirror of the
// live role_permissions table, documented in its own prior header
// comment as able to silently drift out of sync.
//
// Both are fixed by keying nav visibility directly off
// ActiveMembership.permissionKeys (real, server-computed via
// caller_permission_keys(), see AuthProvider) instead of roleKey. A
// role -- system or custom -- sees a nav domain if it holds at least
// one of that domain's representative permission keys. This is still a
// CLIENT-SIDE UX convenience only, same as before -- RLS/RPC
// has_permission() checks remain the real security boundary
// (RequireNavDomain's own header comment, unchanged).

export type NavDomain =
  | 'today'
  | 'bookings'
  | 'customers'
  | 'academy'
  | 'memberships'
  | 'finance'
  | 'reports'
  | 'whatsapp'
  | 'staff'
  | 'settings'
  | 'scan'

/**
 * Domain -> the permission key(s) that make that domain relevant to
 * show in the nav. A domain is visible if the caller holds ANY ONE of
 * its listed keys (matches how the previous role map worked: a role
 * saw a domain if it had "at least one permission relevant to that
 * item's domain"). Derived directly from the real permission catalog
 * (docs/CURRENT_AUTHORIZATION_MODEL.md Section 2), not invented.
 */
const NAV_DOMAIN_PERMISSIONS: Record<Exclude<NavDomain, 'today'>, readonly string[]> = {
  bookings: ['booking.view', 'booking.create'],
  customers: ['customer.view', 'customer.create'],
  academy: [
    'enrollment.view', 'enrollment.create', 'academy.group.manage', 'academy.program.manage',
    'session.view', 'attendance.view', 'attendance.mark',
  ],
  // CLUB MEMBERSHIPS domain (2026-08-26) -- a genuine top-level main
  // domain, deliberately never nested under academy (directive Section
  // 96/111: Club Membership is NOT academy enrollment).
  memberships: [
    'club_membership.plan.view', 'club_membership.view', 'club_membership.create',
    'club_membership.renew', 'club_membership.freeze', 'club_membership.cancel',
  ],
  finance: ['payment.view', 'payment.create', 'invoice.view', 'invoice.create', 'payment.refund'],
  reports: ['report.view'],
  whatsapp: ['manage_whatsapp_connection'],
  staff: ['staff.view', 'staff.create', 'staff.update', 'roles.view', 'roles.manage'],
  settings: ['club.update', 'branch.create', 'branch.update', 'field.create', 'field.update', 'pricing.update'],
  scan: ['qr.scan', 'qr.checkin.confirm'],
}

/**
 * `today` (the operational dashboard) has no permission gate of its own
 * -- every active member of a club sees it, matching the pre-existing
 * behavior (it was in every role's set in the old map, including
 * scanner/coach) and TodayPage's own internal role-conditional sections
 * for anything more specific.
 *
 * club_owner is not special-cased here (unlike the old map, which
 * hard-coded it to "always sees everything") -- system-role seeding
 * grants club_owner every permission key that exists (confirmed:
 * role_permissions has a row for club_owner × every permission), so it
 * naturally satisfies every domain's check without a special case. This
 * removes a second, redundant source of truth for "owner sees
 * everything" -- if that seeding assumption is ever wrong, this
 * function will now honestly reflect it instead of silently
 * overriding it.
 */
export function canSeeNavDomain(permissionKeys: readonly string[] | undefined, domain: NavDomain): boolean {
  if (domain === 'today') return true
  if (!permissionKeys || permissionKeys.length === 0) return false
  const required = NAV_DOMAIN_PERMISSIONS[domain]
  return required.some((key) => permissionKeys.includes(key))
}

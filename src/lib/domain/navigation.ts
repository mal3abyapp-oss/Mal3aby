// Shared role-based navigation visibility -- IA restructuring (Phase 3,
// shared navigation foundation). Confirmed gap in
// MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md: AppLayout's own code
// comment documented this as an intended, never-implemented Phase 2
// task -- every staff role saw all 9 sidebar items regardless of
// whether their permissions let them act on that screen (RLS always
// prevented any actual data leak; this was a UX-clarity gap, not a
// security gap -- a coach or scanner account saw "الموظفون"/"التقارير"
// links they could never meaningfully use).
//
// This does NOT introduce a new permission-fetching round trip --
// `currentMembership.roleKey` is already available client-side (see
// src/lib/domain/membership.ts) and is exactly what every existing
// per-screen role check (isManager/isCoach/etc.) already keys off of.
// The mapping below mirrors the real role_permissions matrix (live
// database, enumerated during the audit) at the granularity that
// matters for nav visibility -- a role sees a nav item if it holds at
// least one permission relevant to that item's domain.
//
// Matches the role-navigation summary in
// MAL3ABY_INFORMATION_ARCHITECTURE.md §6 exactly.

export type NavDomain =
  | 'today'
  | 'bookings'
  | 'customers'
  | 'academy'
  | 'finance'
  | 'reports'
  | 'whatsapp'
  | 'staff'
  | 'settings'
  | 'scan'

/**
 * Role -> set of nav domains that role should see. `club_owner` is
 * deliberately not listed -- it always sees everything (matches every
 * existing owner-only conditional elsewhere in the app, e.g.
 * TodayPage's isOwner).
 */
// Master IA/UX audit (permission-model drift-risk phase): this map is a
// hand-maintained mirror of the live role_permissions table, so it can
// silently drift out of sync as permissions are added/changed in the DB
// without anyone updating this file (a real maintenance-drift risk, not
// a live security bug -- RLS remains the actual authorization boundary,
// this only controls nav-item visibility). A live comparison against
// role_permissions (via SQL, not guessed) found 4 confirmed cases where
// a role had real, relevant DB permissions for a domain that was
// nonetheless hidden from its nav -- fixed below. No case was found of
// a domain granted with zero backing permissions.
const ROLE_NAV_DOMAINS: Record<string, ReadonlySet<NavDomain>> = {
  club_owner: new Set<NavDomain>([
    'today', 'bookings', 'customers', 'academy', 'finance', 'reports', 'whatsapp', 'staff', 'settings', 'scan',
  ]),
  club_manager: new Set<NavDomain>([
    'today', 'bookings', 'customers', 'academy', 'finance', 'reports', 'whatsapp', 'staff', 'settings', 'scan',
  ]),
  // branch_manager holds branch.update + field.update/view (confirmed
  // live) -- exactly what the 'settings' domain gates (/app/fields,
  // /app/settings) -- but 'settings' was withheld entirely.
  branch_manager: new Set<NavDomain>([
    'today', 'bookings', 'customers', 'academy', 'finance', 'reports', 'whatsapp', 'settings', 'scan',
  ]),
  // receptionist holds enrollment.view + player.create/view +
  // subscription.view (confirmed live) -- three distinct academy-domain
  // permission families including a real create right -- but 'academy'
  // was withheld entirely.
  receptionist: new Set<NavDomain>([
    'today', 'bookings', 'customers', 'finance', 'academy', 'scan',
  ]),
  // accountant holds enrollment.view + player.view + subscription.view
  // (confirmed live) -- the full breadth of what 'academy' exposes,
  // plausibly needed for billing/reconciliation context -- but 'academy'
  // was withheld entirely. (booking.view alone was judged too weak a
  // signal to also add 'bookings' here -- single view-only permission,
  // not central to this role's workflow -- left as-is.)
  accountant: new Set<NavDomain>([
    'today', 'customers', 'finance', 'reports', 'academy',
  ]),
  // academy_manager holds invoice.create + invoice.view (confirmed
  // live) -- invoice.create is a real write capability squarely in the
  // 'finance' domain -- but 'finance' was withheld entirely.
  academy_manager: new Set<NavDomain>([
    'today', 'academy', 'customers', 'reports', 'finance',
  ]),
  coach: new Set<NavDomain>([
    'today', 'academy', 'scan',
  ]),
  scanner: new Set<NavDomain>([
    'scan',
  ]),
}

/** Roles with no explicit entry (should not normally happen -- platform_owner never reaches AppLayout) see everything, matching the pre-existing behavior as a safe fallback rather than hiding nav for an unrecognized role. */
export function canSeeNavDomain(roleKey: string | undefined, domain: NavDomain): boolean {
  if (!roleKey) return true
  const allowed = ROLE_NAV_DOMAINS[roleKey]
  if (!allowed) return true
  return allowed.has(domain)
}

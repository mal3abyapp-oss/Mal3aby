// STAFF ACCESS CONTROL & CUSTOM ROLES (2026-08-25) -- Stage 2/6.
//
// Groups the real, live permission catalog (54 keys, confirmed via
// direct DB query -- see docs/CURRENT_AUTHORIZATION_MODEL.md) into the
// UI groups the phase directive asked for, so the Role Editor never
// shows a flat, unstructured 54-checkbox list. Every key below is a
// REAL row in the `permissions` table -- this file does not invent any
// key; it only organizes and labels the ones that already exist.
//
// A key intentionally absent from every group here (there are none at
// the time of writing -- every live key has a home) would still work
// correctly if the Role Editor falls back to an "other" bucket; this is
// a display concern only, never a source of truth for what a role can
// do (that is exclusively role_permissions / club_role_permissions).

export type PermissionGroupKey =
  | 'main'
  | 'bookings'
  | 'customers'
  | 'academy'
  | 'memberships'
  | 'shop'
  | 'inventory'
  | 'finance'
  | 'cash'
  | 'reports'
  | 'staff'
  | 'branches'
  | 'settings'
  | 'audit'

export interface PermissionDef {
  key: string
  /** True for a permission whose grant deserves a visible "sensitive" marker in the Role Editor (Section 6 of the phase directive). */
  sensitive?: boolean
  /**
   * Other permission keys this one requires to be coherent (Section 5).
   * For most pairs this is a client-side UX hint only -- the server
   * does not re-derive or enforce it (an "incoherent but non-escalating"
   * role, e.g. booking.update without booking.view, is unusual but not
   * unsafe). cash.liability.settle is the one exception: its dependency
   * on cash.liability.view is also enforced server-side, in
   * create_club_role()/update_club_role() via
   * permission_set_violates_dependency() (see the
   * permission_dependency_enforcement migration) -- a role with settle
   * but not view cannot be saved even by a direct RPC call, not just
   * blocked in this UI.
   */
  requires?: string[]
}

export interface PermissionGroup {
  key: PermissionGroupKey
  permissions: PermissionDef[]
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    key: 'bookings',
    permissions: [
      { key: 'booking.view' },
      { key: 'booking.create', requires: ['booking.view'] },
      { key: 'booking.update', requires: ['booking.view'] },
      { key: 'booking.cancel', requires: ['booking.view'] },
      { key: 'booking.discount.apply', requires: ['booking.create'] },
      { key: 'booking.discount.override', sensitive: true, requires: ['booking.discount.apply'] },
    ],
  },
  {
    key: 'customers',
    permissions: [
      { key: 'customer.view' },
      { key: 'customer.create', requires: ['customer.view'] },
      { key: 'customer.update', requires: ['customer.view'] },
      { key: 'player.view' },
      { key: 'player.create', requires: ['player.view'] },
      { key: 'player.update', requires: ['player.view'] },
      { key: 'player.medical_notes.view', sensitive: true, requires: ['player.view'] },
      { key: 'player.medical_notes.update', sensitive: true, requires: ['player.medical_notes.view'] },
    ],
  },
  {
    key: 'academy',
    permissions: [
      { key: 'academy.group.manage' },
      { key: 'academy.program.manage' },
      { key: 'enrollment.view' },
      { key: 'enrollment.create', requires: ['enrollment.view'] },
      { key: 'enrollment.update', requires: ['enrollment.view'] },
      { key: 'session.view' },
      { key: 'session.manage', requires: ['session.view'] },
      { key: 'attendance.view' },
      { key: 'attendance.mark', requires: ['attendance.view'] },
      { key: 'subscription.view' },
      { key: 'subscription.create', requires: ['subscription.view'] },
      { key: 'subscription.update', requires: ['subscription.view'] },
      { key: 'subscription.freeze.create', requires: ['subscription.update'] },
    ],
  },
  {
    key: 'memberships',
    permissions: [
      // CLUB MEMBERSHIPS domain (2026-08-26) -- an independent commercial
      // domain (NOT academy enrollment, NOT the platform SaaS
      // subscription). club_membership.verify deliberately has NO
      // `requires` -- a Scanner-only role must be able to hold verify
      // without ever being granted view (directive Section 47/50).
      // plan.manage and cancel are Sensitive: plan.manage changes what
      // customers can buy club-wide; cancel stops an active paid
      // entitlement immediately.
      { key: 'club_membership.plan.view' },
      { key: 'club_membership.plan.manage', sensitive: true, requires: ['club_membership.plan.view'] },
      { key: 'club_membership.view' },
      { key: 'club_membership.create', requires: ['club_membership.view'] },
      { key: 'club_membership.renew', requires: ['club_membership.view'] },
      { key: 'club_membership.freeze', requires: ['club_membership.view'] },
      { key: 'club_membership.cancel', sensitive: true, requires: ['club_membership.view'] },
      { key: 'club_membership.verify' },
    ],
  },
  {
    // COMMERCIAL MODULE ARCHITECTURE (2026-08-26) -- Shop and Inventory
    // are two distinct groups (directive Section 6's own instruction:
    // "Group clearly: Store / Shop, Inventory") even though both live
    // under the same /app/shop module -- selling and stock-keeping are
    // different jobs with different defaults (a receptionist sells but
    // never adjusts stock, confirmed by the seeded default matrix).
    key: 'shop',
    permissions: [
      { key: 'shop.view' },
      { key: 'shop.product.manage', requires: ['shop.view'] },
      { key: 'shop.sale.create', requires: ['shop.view'] },
      { key: 'shop.sale.refund', sensitive: true, requires: ['shop.view'] },
    ],
  },
  {
    key: 'inventory',
    permissions: [
      { key: 'inventory.view' },
      { key: 'inventory.receive', requires: ['inventory.view'] },
      { key: 'inventory.adjust', sensitive: true, requires: ['inventory.view'] },
      { key: 'inventory.transfer', requires: ['inventory.view'] },
      { key: 'inventory.count', requires: ['inventory.view'] },
      { key: 'inventory.cost.view', sensitive: true, requires: ['inventory.view'] },
    ],
  },
  {
    key: 'finance',
    permissions: [
      { key: 'invoice.view' },
      { key: 'invoice.create', requires: ['invoice.view'] },
      { key: 'invoice.update', requires: ['invoice.view'] },
      { key: 'payment.view' },
      { key: 'payment.create', requires: ['payment.view'] },
      { key: 'payment.verify', requires: ['payment.view'] },
      { key: 'payment.refund', sensitive: true, requires: ['payment.view'] },
      { key: 'payment.methods.view' },
      { key: 'payment.methods.manage', sensitive: true, requires: ['payment.methods.view'] },
      // EXPENSES FEATURE (2026-08-30) -- see
      // 20260830010000_expenses_feature.sql for the server-side seed
      // this mirrors (club_owner/club_manager/branch_manager/accountant
      // by default).
      { key: 'expense.view' },
      { key: 'expense.create', sensitive: true, requires: ['expense.view'] },
      { key: 'expense.void', sensitive: true, requires: ['expense.view'] },
      { key: 'expense.category.manage', requires: ['expense.view'] },
    ],
  },
  {
    key: 'cash',
    permissions: [
      // Cash custody itself is a per-person flag (has_cash_custody),
      // not a permissions-table row -- deliberately not listed here
      // (see StaffPage.tsx's existing custody toggle, unaffected by
      // this phase).
      //
      // DEDICATED CASH LIABILITY PERMISSIONS (2026-08-26): employee
      // shortage/liability visibility and settlement used to ride on
      // staff.update or payment.create (an indirect substitute) -- now
      // dedicated, narrower permissions. cash.liability.settle is a
      // Sensitive Permission (can move real money-equivalent state) and
      // requires cash.liability.view, enforced both here and
      // server-side (see the `requires` doc comment above).
      { key: 'cash.liability.view' },
      { key: 'cash.liability.settle', sensitive: true, requires: ['cash.liability.view'] },
    ],
  },
  {
    key: 'reports',
    permissions: [
      { key: 'report.view' },
      { key: 'notification.view' },
    ],
  },
  {
    key: 'staff',
    permissions: [
      { key: 'staff.view' },
      { key: 'staff.create', sensitive: true, requires: ['staff.view'] },
      { key: 'staff.update', sensitive: true, requires: ['staff.view'] },
      { key: 'roles.view' },
      { key: 'roles.manage', sensitive: true, requires: ['roles.view'] },
    ],
  },
  {
    key: 'branches',
    permissions: [
      { key: 'field.view' },
      { key: 'field.create', requires: ['field.view'] },
      { key: 'field.update', requires: ['field.view'] },
      { key: 'branch.create' },
      { key: 'branch.update' },
      { key: 'pricing.view' },
      { key: 'pricing.update', requires: ['pricing.view'] },
      { key: 'qr.scan' },
      { key: 'qr.checkin.confirm', requires: ['qr.scan'] },
    ],
  },
  {
    key: 'settings',
    permissions: [
      { key: 'club.update', sensitive: true },
      { key: 'manage_whatsapp_connection', sensitive: true },
    ],
  },
  {
    key: 'audit',
    permissions: [
      // audit_logs visibility today is role-name-gated
      // (club_owner/club_manager/branch_manager), not a permissions-row
      // -- documented as a pre-existing exception in
      // CURRENT_AUTHORIZATION_MODEL.md Section 3, deliberately not
      // changed by this phase (out of scope: would require its own RLS
      // migration unrelated to custom roles). No permission key exists
      // to list here yet.
    ],
  },
]

/** Every real permission key, flattened, for validation/lookup. */
export const ALL_CATALOG_KEYS = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key))

export function findPermissionDef(key: string): PermissionDef | undefined {
  for (const group of PERMISSION_GROUPS) {
    const found = group.permissions.find((p) => p.key === key)
    if (found) return found
  }
  return undefined
}

/**
 * Given a set of currently-selected permission keys and a key being
 * turned ON, return the keys that must also turn on (transitive
 * dependency closure) -- Section 5 of the phase directive ("cannot
 * configure an illogical role"). Client-side convenience only; the
 * server never trusts or re-derives this -- it only rejects nothing
 * extra and grants exactly what was requested (permission escalation
 * is checked, dependency coherence is not re-validated server-side,
 * since an "incoherent but non-escalating" role, e.g. booking.update
 * without booking.view, is unusual but not unsafe).
 */
export function resolveDependencyClosure(selected: ReadonlySet<string>, turningOn: string): string[] {
  const toAdd = new Set<string>()
  const visit = (key: string) => {
    const def = findPermissionDef(key)
    if (!def?.requires) return
    for (const dep of def.requires) {
      if (!selected.has(dep) && !toAdd.has(dep)) {
        toAdd.add(dep)
        visit(dep)
      }
    }
  }
  visit(turningOn)
  return Array.from(toAdd)
}

/**
 * Given a set of currently-selected permission keys and a key being
 * turned OFF, return every OTHER selected key that depends on it
 * (transitively) and must turn off too, so the resulting set never has
 * a dangling requirement (e.g. turning off booking.view while
 * booking.create stays on).
 */
export function resolveDependents(selected: ReadonlySet<string>, turningOff: string): string[] {
  const toRemove = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const key of selected) {
      if (key === turningOff || toRemove.has(key)) continue
      const def = findPermissionDef(key)
      if (def?.requires?.some((dep) => dep === turningOff || toRemove.has(dep))) {
        toRemove.add(key)
        changed = true
      }
    }
  }
  return Array.from(toRemove)
}

-- CLUB MEMBERSHIPS domain -- permission catalog + default role matrix.
--
-- 7 new keys, prefixed club_membership. to avoid any collision with
-- academy's subscription.* keys or the staff club_memberships domain.
insert into public.permissions (key, description) values
  ('club_membership.plan.view', 'View club membership plans'),
  ('club_membership.plan.manage', 'Create, edit, deactivate, or archive club membership plans'),
  ('club_membership.view', 'View club memberships and their history'),
  ('club_membership.create', 'Sell a new club membership to a customer'),
  ('club_membership.renew', 'Renew an existing club membership'),
  ('club_membership.freeze', 'Freeze or resume a club membership'),
  ('club_membership.cancel', 'Cancel a club membership'),
  ('club_membership.verify', 'Verify a club membership QR code at the scanner')
on conflict (key) do nothing;

-- Dependencies, reusing the generic permission_dependencies mechanism
-- built in the Cash Liability Permissions phase -- enforced both in
-- the Role Editor UI (permissionCatalog.ts) AND server-side
-- (create_club_role/update_club_role via permission_set_violates_
-- dependency()), matching directive Section 48 exactly.
insert into public.permission_dependencies (permission_key, requires_key) values
  ('club_membership.plan.manage', 'club_membership.plan.view'),
  ('club_membership.create', 'club_membership.view'),
  ('club_membership.renew', 'club_membership.view'),
  ('club_membership.freeze', 'club_membership.view'),
  ('club_membership.cancel', 'club_membership.view')
on conflict do nothing;
-- club_membership.verify deliberately has NO dependency on
-- club_membership.view -- directive Section 47/50: "verify لا يحتاج
-- full customer-management permission" -- a Scanner-only role must be
-- able to hold verify without ever being granted view.

-- Default system-role matrix, exactly per directive Section 50:
--
-- Club Owner:     ALL
-- Club Manager:   plan.view, view, create, renew, freeze, cancel, verify
--                 (NOT plan.manage -- directive: "owner-only product
--                 management أكثر اتساقًا" when in doubt; no existing
--                 signal that club_manager owns product definitions
--                 anywhere else in this app -- academy group/pricing
--                 management already leans owner-adjacent too)
-- Reception:      view, create, renew, verify (NOT plan.manage, cancel,
--                 freeze by default)
-- Accountant:     view only (financial visibility, no entitlement ops)
-- Coach:          DENY
-- Scanner:        verify only
-- Academy Manager: DENY (directive Section 50, explicit)
-- Branch Manager: not named explicitly in the directive matrix -- given
--                 branch_manager's existing role profile (view-only on
--                 cash liability, operational-but-not-financial), grant
--                 the same operational set as club_manager MINUS
--                 plan.manage, matching its established narrower-than-
--                 club_manager profile from the Cash Liability phase.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'club_owner' and p.key in (
  'club_membership.plan.view', 'club_membership.plan.manage',
  'club_membership.view', 'club_membership.create', 'club_membership.renew',
  'club_membership.freeze', 'club_membership.cancel', 'club_membership.verify'
)
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key in ('club_manager', 'branch_manager') and p.key in (
  'club_membership.plan.view',
  'club_membership.view', 'club_membership.create', 'club_membership.renew',
  'club_membership.freeze', 'club_membership.cancel', 'club_membership.verify'
)
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'receptionist' and p.key in (
  'club_membership.view', 'club_membership.create', 'club_membership.renew', 'club_membership.verify'
)
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'accountant' and p.key = 'club_membership.view'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'scanner' and p.key = 'club_membership.verify'
on conflict do nothing;

-- coach, academy_manager: no grant (DENY/DENY across the board,
-- matching the mandated matrix exactly -- nothing to insert).
-- platform_owner: unchanged, no explicit grant -- consistent with
-- every prior phase's platform_owner handling in this codebase (no
-- automatic bypass added at this layer; platform_owner's own global
-- capabilities are handled elsewhere in the architecture, unrelated to
-- per-club has_permission() checks).
--
-- Custom roles: zero exist in production (reconfirmed live before this
-- migration) -- no backfill needed or performed, consistent with the
-- "old custom roles must start WITHOUT new permissions" rule
-- established in the Cash Liability Permissions phase.

-- Seed data. Applied automatically by `supabase start` / `supabase db reset`
-- locally, and run once manually against the remote project after migrations
-- (see docs/PROJECT_RULES.md rule 7: migrations + this file are the only
-- schema/reference-data authority).

-- ============================================================
-- Roles (Phase 2) -- see docs/DATABASE_BLUEPRINT.md#roles
-- ============================================================

insert into public.roles (key, name, name_ar) values
  ('platform_owner', 'Platform Owner', 'مالك المنصة'),
  ('club_owner', 'Club Owner', 'صاحب النادي'),
  ('club_manager', 'Club Manager', 'مدير النادي'),
  ('branch_manager', 'Branch Manager', 'مدير الفرع'),
  ('receptionist', 'Receptionist', 'موظف استقبال'),
  ('accountant', 'Accountant', 'محاسب'),
  ('academy_manager', 'Academy Manager', 'مدير الأكاديمية'),
  ('coach', 'Coach', 'مدرب'),
  ('scanner', 'Scanner', 'ماسح QR')
on conflict (key) do nothing;

-- ============================================================
-- Permissions (Phase 2 baseline -- extended per phase as each domain lands)
-- Keys per docs/RLS_MATRIX.md and docs/SECURITY_ANTI_FRAUD.md.
-- ============================================================

insert into public.permissions (key, description) values
  ('club.update', 'Update own club settings'),
  ('branch.create', 'Create a branch'),
  ('branch.update', 'Update a branch'),
  ('staff.create', 'Add a staff member / membership'),
  ('staff.update', 'Update a staff member''s role/branch scope')
on conflict (key) do nothing;

-- ============================================================
-- Role -> Permission grants (Phase 2 baseline)
-- ============================================================

-- Club Owner: full club/branch/staff management within their own club.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'club_owner'
  and p.key in ('club.update', 'branch.create', 'branch.update', 'staff.create', 'staff.update')
on conflict do nothing;

-- Club Manager: branch/staff management, not club-level settings.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'club_manager'
  and p.key in ('branch.create', 'branch.update', 'staff.create', 'staff.update')
on conflict do nothing;

-- Branch Manager: can update their own branch only (branch-scope enforced
-- via membership_branches, not by this permission grant).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'branch_manager'
  and p.key in ('branch.update')
on conflict do nothing;

-- Note: platform_owner does not need explicit permission grants here --
-- Platform Owner access is granted via the auth.is_platform_owner()
-- bypass policies (role key check), not the standard permission model.
-- See docs/DECISIONS.md ADR-014 for why role-key checks are otherwise
-- forbidden -- this is the one deliberate, documented exception, scoped
-- to a single well-known bypass function, not scattered role===x checks.

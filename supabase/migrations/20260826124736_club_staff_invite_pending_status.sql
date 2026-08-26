-- CLUB STAFF ONBOARDING (2026-08-26) -- directive Section 20/30: the
-- current invite_staff_member() flow can only attach an EXISTING
-- auth.users account (hard FK on club_memberships.user_id, confirmed
-- via pg_get_functiondef -- it raises 'no account found for that email
-- -- the person must sign up first' otherwise). A club cannot onboard a
-- brand-new employee who has never used Mal3aby. This is a real,
-- confirmed operational gap, not speculative.
--
-- Fix, staged across a few migrations for parity/rollback clarity:
-- this one widens club_memberships.status to add 'invited' -- a
-- membership row that exists (so role/branch assignment is already
-- captured) but whose auth user has not yet completed activation.
-- has_permission() already filters `cm.status = 'active'` (confirmed
-- via pg_get_functiondef), so an 'invited' row is correctly a NO-OP for
-- every authorization check without any additional code -- it simply
-- grants nothing until the row is flipped to 'active' on first login,
-- exactly mirroring how 'inactive' already behaves today.
alter table public.club_memberships drop constraint club_memberships_status_check;
alter table public.club_memberships add constraint club_memberships_status_check
  check (status = any (array['active', 'invited', 'inactive']));

comment on column public.club_memberships.status is
  'active: normal member. invited: account created/linked, awaiting first login (has_permission() denies everything while in this state, same as inactive). inactive: suspended/deactivated.';

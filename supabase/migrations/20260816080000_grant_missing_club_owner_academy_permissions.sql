-- V1 Critical Fix Pass (2026-08-16): P1-3 root cause. club_owner is a
-- pure grants-table role (has_permission() has no owner special-case --
-- confirmed by reading the function body), yet 8 real operational
-- permissions were never granted to it: academy.group.manage,
-- academy.program.manage, enrollment.create, enrollment.update,
-- subscription.create, subscription.update, subscription.freeze.create,
-- session.manage. This silently blocked the account that owns the club
-- from completing nearly the entire academy workflow end-to-end --
-- exactly the "academy does not work" symptom reported. club_manager
-- and academy_manager already have these; club_owner must have
-- everything a club_manager has, at minimum, in their own club.
insert into public.role_permissions (role_id, permission_id)
select
  (select id from public.roles where key = 'club_owner'),
  p.id
from public.permissions p
where p.key in (
  'academy.group.manage',
  'academy.program.manage',
  'enrollment.create',
  'enrollment.update',
  'subscription.create',
  'subscription.update',
  'subscription.freeze.create',
  'session.manage'
)
on conflict (role_id, permission_id) do nothing;

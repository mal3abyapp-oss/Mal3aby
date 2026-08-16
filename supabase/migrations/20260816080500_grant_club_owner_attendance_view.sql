-- V1 Critical Fix Pass (2026-08-16): club_owner should be able to see
-- everything happening in their own club for oversight, even actions
-- (like marking attendance) that stay coach/academy_manager-scoped to
-- perform. attendance.mark deliberately stays coach-only -- a club
-- owner attending training sessions personally isn't the expected
-- workflow -- but attendance.view (read-only) should not be blocked.
insert into public.role_permissions (role_id, permission_id)
select
  (select id from public.roles where key = 'club_owner'),
  p.id
from public.permissions p
where p.key = 'attendance.view'
on conflict (role_id, permission_id) do nothing;

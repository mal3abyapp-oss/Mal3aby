-- Final Release Gate (2026-08-15): TEMPORARY. Grants two additional
-- club_memberships rows (club_manager, academy_manager) to
-- moustafa.elsafy2@gmail.com on the verification club, solely to run the
-- Player -> Enrollment -> Subscription -> Session -> Attendance smoke
-- chain with a real JWT. club_owner is intentionally select-only on
-- programs/enrollments/subscriptions per docs/RLS_MATRIX.md (confirmed
-- correct by design during this same gate, not a bug); training_sessions
-- insert specifically requires academy_manager or coach (session.manage),
-- club_manager alone is not sufficient for that one table -- confirmed
-- against role_permissions directly before adding this second grant.
--
-- MUST be reverted by the paired migration
-- 20260815390500_revert_temp_club_manager_grant.sql immediately after
-- the smoke test completes -- do not leave these memberships active.
insert into public.club_memberships (user_id, club_id, role_id, status)
select
  (select id from auth.users where email = 'moustafa.elsafy2@gmail.com'),
  '0d533d74-c98e-49f1-a59b-b3d75a5af133',
  (select id from public.roles where key = 'club_manager'),
  'active';

insert into public.club_memberships (user_id, club_id, role_id, status)
select
  (select id from auth.users where email = 'moustafa.elsafy2@gmail.com'),
  '0d533d74-c98e-49f1-a59b-b3d75a5af133',
  (select id from public.roles where key = 'academy_manager'),
  'active';

-- mark_attendance requires attendance.mark specifically, which per
-- role_permissions is granted only to 'coach' (academy_manager alone is
-- insufficient for this one RPC, even with session.manage) -- matches
-- the Phase 12 design note "attendance marking is Coach-only in this
-- schema", confirmed directly against role_permissions before adding.
insert into public.club_memberships (user_id, club_id, role_id, status)
select
  (select id from auth.users where email = 'moustafa.elsafy2@gmail.com'),
  '0d533d74-c98e-49f1-a59b-b3d75a5af133',
  (select id from public.roles where key = 'coach'),
  'active';

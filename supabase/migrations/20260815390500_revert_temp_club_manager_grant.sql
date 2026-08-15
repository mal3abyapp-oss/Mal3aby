-- Final Release Gate (2026-08-15): reverts the three TEMPORARY
-- club_memberships rows (club_manager, academy_manager, coach) granted
-- in 20260815390000_temp_grant_club_manager_for_academy_smoke_test.sql
-- to moustafa.elsafy2@gmail.com on the verification club, used solely to
-- run the Player -> Enrollment -> Subscription -> Session -> Attendance
-- smoke chain with a real JWT. This account keeps only its original
-- club_owner (this club) and platform_owner (global) memberships after
-- this migration -- no lingering elevated test privileges.
delete from public.club_memberships
where user_id = (select id from auth.users where email = 'moustafa.elsafy2@gmail.com')
  and club_id = '0d533d74-c98e-49f1-a59b-b3d75a5af133'
  and role_id in (
    select id from public.roles where key in ('club_manager', 'academy_manager', 'coach')
  );

-- The training-session coach_id assignment made during the smoke test is
-- reference data on a test group in a test club, not a security-relevant
-- privilege -- left in place, matching how field/pricing/enrollment test
-- rows from this same chain are left as inventoried, explained test data
-- rather than deleted mid-migration.

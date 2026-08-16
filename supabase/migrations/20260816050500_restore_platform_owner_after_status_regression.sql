-- V1 Implementation Gap Audit (2026-08-16): restores the platform_owner
-- membership removed by 20260816050000_temp_remove_platform_owner_for_status_regression.sql
-- immediately after confirming the club-status-protection trigger fix
-- (20260816040000) correctly blocks a club_owner-only session while
-- still allowing other clubs.* column updates.
insert into public.club_memberships (user_id, club_id, role_id, status)
select
  (select id from auth.users where email = 'moustafa.elsafy2@gmail.com'),
  '0d533d74-c98e-49f1-a59b-b3d75a5af133',
  (select id from public.roles where key = 'platform_owner'),
  'active';

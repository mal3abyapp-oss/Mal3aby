-- V1 Implementation Gap Audit (2026-08-16): reverts the TEMPORARY
-- academy_manager grant from 20260816030000_temp_grant_for_group_edit_regression.sql
-- used solely to regression-test the group-capacity edit UI.
delete from public.club_memberships
where user_id = (select id from auth.users where email = 'moustafa.elsafy2@gmail.com')
  and club_id = '0d533d74-c98e-49f1-a59b-b3d75a5af133'
  and role_id = (select id from public.roles where key = 'academy_manager');

-- Restore the test group's capacity to its pre-test value.
update public.groups set capacity = 20 where id = '97a787db-ddf5-4c3f-bed1-609de592b810';

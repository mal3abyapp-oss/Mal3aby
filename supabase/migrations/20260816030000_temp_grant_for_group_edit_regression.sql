-- V1 Implementation Gap Audit (2026-08-16): TEMPORARY. Grants
-- academy_manager to moustafa.elsafy2@gmail.com on the verification club
-- solely to regression-test the new group-capacity edit UI against a
-- role that RLS_MATRIX.md actually permits (club_owner is intentionally
-- select-only on groups, confirmed correct by design, same as the
-- academy tables investigated during the earlier stabilization pass).
-- MUST be reverted immediately after -- see the paired revert migration.
insert into public.club_memberships (user_id, club_id, role_id, status)
select
  (select id from auth.users where email = 'moustafa.elsafy2@gmail.com'),
  '0d533d74-c98e-49f1-a59b-b3d75a5af133',
  (select id from public.roles where key = 'academy_manager'),
  'active';

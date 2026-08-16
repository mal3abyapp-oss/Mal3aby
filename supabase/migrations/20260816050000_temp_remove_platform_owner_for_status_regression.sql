-- V1 Implementation Gap Audit (2026-08-16): TEMPORARY. Removes the
-- platform_owner membership from moustafa.elsafy2@gmail.com so the
-- club-status-protection trigger fix (20260816040000) can be regression-
-- tested against a session that is genuinely club_owner-only -- the
-- account otherwise also holds platform_owner (from the earlier release
-- gate), which made an initial test of this fix misleadingly "pass"
-- (is_platform_owner() correctly returned true for that session, so the
-- trigger correctly let the status change through -- not a bug, but not
-- a valid test of the club_owner-denied case either).
-- MUST be restored immediately after -- see the paired restore migration.
delete from public.club_memberships
where user_id = (select id from auth.users where email = 'moustafa.elsafy2@gmail.com')
  and role_id = (select id from public.roles where key = 'platform_owner');

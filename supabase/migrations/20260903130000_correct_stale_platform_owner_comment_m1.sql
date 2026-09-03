-- Production Audit Remediation, M-1 correction (2026-09-03): the
-- deployed function comment on protect_club_status_from_non_platform_owner()
-- (added by 20260903100000_protect_clubs_test_fixture_and_flagged_
-- duplicate_columns.sql) incorrectly referenced a
-- "clubs_platform_owner_full_access" ALL-policy as an existing,
-- unaffected write path for platform_owner. Independent P0 verification
-- confirmed live that policy does not exist -- it was dropped by
-- 20260829040000_revoke_unaudited_platform_owner_direct_writes.sql, and
-- platform_owner currently has no direct-UPDATE path to public.clubs at
-- all (the only UPDATE policy live on this table is
-- clubs_update_own_club_owner). This migration corrects only the
-- function's DB-level comment to match verified reality; the trigger's
-- SQL logic is unchanged (CREATE OR REPLACE was not needed/used here --
-- COMMENT ON is independent of the function body).
comment on function public.protect_club_status_from_non_platform_owner() is
  'Production audit remediation (M-1): BEFORE UPDATE trigger on public.clubs that reverts status, is_test_fixture, and flagged_duplicate to their pre-update values whenever the acting role is not platform_owner, since clubs_update_own_club_owner has no WITH CHECK and RLS cannot express column-level restrictions on its own. platform_owner currently has no direct-UPDATE path to public.clubs at all (clubs_update_own_club_owner is the only UPDATE policy live on this table as of the 2026-08-29 zero-trust hardening; the is_platform_owner() check here is future-proofing for any later audited platform_owner-write RPC, not an active bypass). is_test_fixture is set only via governed migration; flagged_duplicate is set only by complete_new_club_onboarding at row-creation INSERT time, never via UPDATE -- so no legitimate write path is blocked.';

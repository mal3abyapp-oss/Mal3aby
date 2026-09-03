-- Production Audit Remediation, finding M-1 (2026-09-03): the same
-- column-level write gap fixed for clubs.status in
-- 20260816040000_fix_club_owner_cannot_change_club_status.sql also
-- exists for clubs.is_test_fixture and clubs.flagged_duplicate.
--
-- clubs_update_own_club_owner (see 20260815120000_phase2_identity_
-- multitenant_rls.sql) grants club_owner UPDATE on their own club via
-- USING only (id in user_club_ids() and has_permission('club.update',
-- id)) -- no WITH CHECK, and no column-level restriction. As with
-- status, RLS's row-level model cannot express "which columns changed"
-- on its own, so any club_owner can PATCH is_test_fixture or
-- flagged_duplicate directly, live-reproduced in the production audit
-- the same way clubs.status was.
--
-- Both columns are administrative-only by design:
--   * is_test_fixture: set exclusively via governed migration (see
--     20260901090000_add_clubs_is_test_fixture_marker.sql's own column
--     comment -- "Set manually via governed migration, never inferred
--     automatically"). No RPC writes it at all.
--   * flagged_duplicate: set exclusively by complete_new_club_onboarding
--     at row *creation* time (INSERT, not UPDATE -- see e.g.
--     20260831095910_fix_onboarding_club_id_variable_conflict.sql line
--     93), as SECURITY DEFINER but still running with the calling
--     user's auth.uid()/role for any RLS checks since it never escalates
--     role. It never re-flags an existing row via UPDATE, so a BEFORE
--     UPDATE trigger cannot interfere with it regardless of who calls
--     it -- confirmed by searching every `update public.clubs` across
--     the migration history: none touches either column outside this
--     file and the original backfill migration itself (which runs as
--     the migration executor, not through club_owner's RLS-restricted
--     session).
--
-- Fixed the same way as status: generalize
-- protect_club_status_from_non_platform_owner() into a single trigger
-- function that reverts all three protected columns to their pre-update
-- values whenever the acting role is not platform_owner, rather than
-- raising (a raise would also block otherwise-legitimate same-statement
-- updates to other columns, e.g. a club_owner's normal Club Settings
-- save). One function covering all three columns is preferable to three
-- separate triggers since they already fire together on every clubs
-- UPDATE.
--
-- CORRECTION (independent P0 verification, 2026-09-03): an earlier
-- draft of this comment claimed platform_owner's own
-- "clubs_platform_owner_full_access" ALL-policy path would be
-- unaffected since is_platform_owner() short-circuits the trigger to a
-- no-op. That policy does not exist on the live schema -- it was
-- explicitly dropped five days earlier by
-- 20260829040000_revoke_unaudited_platform_owner_direct_writes.sql, a
-- deliberate zero-trust hardening migration. Live-confirmed via
-- pg_policies/role_permissions: the only UPDATE policy on public.clubs
-- today is clubs_update_own_club_owner, and the platform_owner role
-- holds no club.update permission grant, so platform_owner currently
-- has NO direct-UPDATE path to this table at all -- by design, per the
-- Aug 29 hardening, which routes all platform_owner writes to clubs
-- through audited RPCs instead. This trigger's is_platform_owner()
-- check is therefore future-proofing (so a later platform_owner-write
-- RPC for these columns is not silently reverted by this trigger if one
-- is ever added, provided that RPC is SECURITY DEFINER the way
-- migrations/postgres-executed writes already are), not something any
-- live path exercises today. Live-verified: an authenticated
-- platform_owner's direct UPDATE attempt on public.clubs affects zero
-- rows via RLS rejection (not this trigger), both before and after this
-- migration -- unchanged behavior.
create or replace function public.protect_club_status_from_non_platform_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_owner() then
    if new.status is distinct from old.status then
      new.status := old.status;
    end if;
    if new.is_test_fixture is distinct from old.is_test_fixture then
      new.is_test_fixture := old.is_test_fixture;
    end if;
    if new.flagged_duplicate is distinct from old.flagged_duplicate then
      new.flagged_duplicate := old.flagged_duplicate;
    end if;
  end if;
  return new;
end;
$$;

-- CREATE OR REPLACE preserves the function's existing grants, so the
-- revoke-from-public/anon/authenticated lockdown already applied by
-- 20260816060000_lockdown_trigger_function_grants.sql carries forward
-- unchanged. Re-stated explicitly anyway, matching this codebase's
-- established convention for every protective trigger function (see
-- 20260818140000_protect_tenant_and_identity_columns.sql) rather than
-- relying on that carry-forward implicitly.
revoke execute on function public.protect_club_status_from_non_platform_owner() from public, anon, authenticated;

-- Trigger name kept as-is (trg_protect_club_status) -- it is already
-- wired to this function and now guards three administrative columns
-- instead of one; renaming it would add churn with no behavioral
-- benefit. drop/create is idempotent and safe to rerun.
drop trigger if exists trg_protect_club_status on public.clubs;
create trigger trg_protect_club_status
  before update on public.clubs
  for each row
  execute function public.protect_club_status_from_non_platform_owner();

comment on function public.protect_club_status_from_non_platform_owner() is
  'Production audit remediation (M-1): BEFORE UPDATE trigger on public.clubs that reverts status, is_test_fixture, and flagged_duplicate to their pre-update values whenever the acting role is not platform_owner, since clubs_update_own_club_owner has no WITH CHECK and RLS cannot express column-level restrictions on its own. platform_owner currently has no direct-UPDATE path to public.clubs at all (clubs_update_own_club_owner is the only UPDATE policy live on this table as of the 2026-08-29 zero-trust hardening; the is_platform_owner() check here is future-proofing for any later audited platform_owner-write RPC, not an active bypass). is_test_fixture is set only via governed migration; flagged_duplicate is set only by complete_new_club_onboarding at row-creation INSERT time, never via UPDATE -- so no legitimate write path is blocked.';

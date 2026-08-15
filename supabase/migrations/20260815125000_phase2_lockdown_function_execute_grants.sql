-- Recovered during Final Pre-Release Verification (2026-08-15): this
-- migration was applied to the remote Mala3by Supabase project (recorded
-- in supabase_migrations.schema_migrations as version 20260815093947,
-- name phase2_lockdown_function_execute_grants -- the real apply-time
-- timestamp) but had no corresponding local file in this repo, so a fresh
-- `supabase db push` would never reconcile it. Content below is
-- byte-accurate to the remote-recorded statements.
--
-- Filed here under a *local* timestamp (20260815125000) later than
-- 20260815120000_phase2_identity_multitenant_rls.sql, rather than under
-- its literal remote timestamp (20260815093947), because this repo's
-- migration filenames are a synthetic, phase-ordered sequence, not
-- apply-time timestamps (see docs/PROJECT_STATE.md migration-parity
-- note) -- placing it at the literal remote timestamp would sort it
-- *before* 20260815120000, which creates the very functions
-- (user_club_ids, has_permission, has_branch_access, is_platform_owner,
-- handle_new_user) this migration revokes EXECUTE on, breaking a fresh
-- `supabase db push` replay. This filename preserves correct dependency
-- order while the header preserves the true remote version for audit.

-- Lock down EXECUTE further: revoke from anon explicitly (schema-level
-- default grants on public functions otherwise leave them anon-callable),
-- and revoke handle_new_user from everyone except the trigger mechanism
-- itself (it must never be directly RPC-callable).

revoke execute on function public.user_club_ids() from anon;
revoke execute on function public.has_permission(text, uuid) from anon;
revoke execute on function public.has_branch_access(uuid, uuid) from anon;
revoke execute on function public.is_platform_owner() from anon;

revoke execute on function public.handle_new_user() from anon;
revoke execute on function public.handle_new_user() from authenticated;
revoke execute on function public.handle_new_user() from public;

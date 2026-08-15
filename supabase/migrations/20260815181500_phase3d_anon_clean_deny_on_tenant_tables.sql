-- Recovered during Final Pre-Release Verification (2026-08-15): applied to
-- the remote Mala3by Supabase project (recorded in
-- supabase_migrations.schema_migrations as version 20260815130632, name
-- phase3d_anon_clean_deny_on_tenant_tables -- the real apply-time
-- timestamp) but had no corresponding local file. Content is
-- byte-accurate to the remote-recorded statement.
--
-- Filed here under a local timestamp (20260815181500, immediately after
-- 20260815181000_phase3d_fix_anon_public_plans_access.sql) rather than its
-- literal remote timestamp, for the same synthetic-ordering reason
-- documented in 20260815125000_phase2_lockdown_function_execute_grants.sql.

-- Defense-in-depth / consistency fix: user_club_ids()/has_permission()/
-- has_branch_access() are used inside role={public} RLS policies on
-- clubs/branches/club_memberships/membership_branches/audit_logs/
-- platform_subscriptions, none of which anon is meant to access at all
-- (no anon-scoped policy exists on any of them). Today anon has no
-- EXECUTE on these functions, so an anon request to any of these tables
-- would currently surface "permission denied for function X" -- an
-- information-shaped error, not a clean RLS deny -- instead of the
-- correct empty-result behavior anon gets on every other properly-denied
-- table (e.g. contact_requests SELECT returns [], not an error).
-- Same reasoning as the is_platform_owner() fix: these functions are
-- stable/read-only and cheap for anon (auth.uid() is null -> the
-- club_memberships lookup inside finds nothing -> empty/false), so
-- granting anon EXECUTE closes the error-shaped leak without granting any
-- actual row access (RLS row-visibility is unchanged -- anon still has
-- zero matching policies on these tables).
grant execute on function public.user_club_ids() to anon;
grant execute on function public.has_permission(text, uuid) to anon;
grant execute on function public.has_branch_access(uuid, uuid) to anon;

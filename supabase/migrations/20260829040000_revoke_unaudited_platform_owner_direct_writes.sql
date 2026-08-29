-- ZERO-TRUST ANTI-FRAUD HARDENING -- Phase 1 (2026-08-29)
--
-- CF-1 from MASTER_ADMIN_ACCESS_BOUNDARY_FINDING.md: a platform owner
-- (or anyone who compromises that account) had a fully unaudited,
-- session-less direct write path to 4 of the most sensitive tables in
-- the schema via plain RLS `ALL`-command policies keyed only on
-- is_platform_owner() -- no session, no mode, no expiry, and critically
-- NO AUDIT TRAIL, completely bypassing every audited RPC this codebase
-- has been built around (set_commercial_entitlements,
-- platform_suspend_club/platform_reactivate_club, manage_branch,
-- set_staff_role, etc).
--
-- LIVE-EXPLOITED AND CONFIRMED during this hardening pass: as the real
-- QA platform owner, `update commercial_entitlements set branch_limit =
-- 999 where club_id = ...` succeeded and left ZERO audit_logs rows --
-- a P0 finding per this program's own severity taxonomy (directive
-- Section 56: "financial tampering" + "audit tampering allowing fraud
-- concealment"). Immediately reverted after confirming (branch_limit
-- restored to null) before writing this fix.
--
-- club_memberships is the single most severe of the four: it directly
-- controls is_platform_owner() itself (role_id -> roles.key =
-- 'platform_owner') -- an attacker with this direct write path could
-- grant themselves or an accomplice permanent platform_owner status at
-- zero audit cost, the single highest-value privilege-escalation target
-- in the entire system.
--
-- FIX: every one of these 4 tables already has a complete, audited,
-- SECURITY DEFINER RPC covering every legitimate platform-owner write
-- need (confirmed live, zero legitimate direct-write frontend call site
-- exists for any of the 4 -- grepped `src/` before this migration):
--   clubs                    -> platform_suspend_club / platform_reactivate_club /
--                                extend_club_qa_subscription / set_club_public_*
--   club_memberships         -> create_club_staff_membership_service /
--                                deactivate_staff_member / reactivate_staff_member /
--                                set_staff_role / set_staff_cash_custody /
--                                complete_new_club_onboarding
--   branches                 -> manage_branch
--   commercial_entitlements  -> set_commercial_entitlements / create_platform_subscription /
--                                set_club_payments_enabled
-- SECURITY DEFINER functions execute with the function owner's
-- privileges, not the caller's -- revoking the caller's direct table
-- grants breaks none of these RPCs.
--
-- This migration replaces each dangerous ALL/write policy with a
-- SELECT-only equivalent, preserving the already-documented, already-
-- accepted platform-owner read-visibility decision (see
-- MASTER_ADMIN_ACCESS_BOUNDARY_FINDING.md's own explicit recommendation
-- to route WRITES through the audited path while leaving reads as a
-- separate, lower-severity, deliberate architectural decision -- not
-- rearchitecting all 31 tables in one migration, only the 4 tables
-- where a live write-bypass was proven exploitable this pass).
--
-- clubs_update_own_club_owner (the real Club-Owner-scoped UPDATE policy
-- used by EnrollmentSection.tsx's subscription_activation_policy
-- setting) is untouched -- this migration only narrows the
-- PLATFORM-OWNER-specific policy, not the legitimate club-owner path.

drop policy if exists clubs_platform_owner_full_access on public.clubs;
create policy clubs_platform_owner_select on public.clubs
  for select
  using (public.is_platform_owner());

drop policy if exists commercial_entitlements_platform_owner_write on public.commercial_entitlements;
create policy commercial_entitlements_platform_owner_select on public.commercial_entitlements
  for select
  using (public.is_platform_owner());

-- SAME BUG CLASS, FOUND WHILE INVESTIGATING CF-1: club_memberships and
-- branches ALSO have "with permission" INSERT/UPDATE policies for
-- ordinary club staff (branches_write_with_permission,
-- branches_update_with_permission,
-- club_memberships_write_with_permission,
-- club_memberships_update_with_permission) that bypass manage_branch()/
-- set_staff_role()/set_staff_cash_custody()/deactivate_staff_member()/
-- reactivate_staff_member() entirely -- LIVE-CONFIRMED exploitable
-- during this pass:
--   - a direct UPDATE flipped a real membership's has_cash_custody to
--     true with zero audit_logs row (immediately reverted after
--     confirming);
--   - a direct UPDATE renamed and deactivated a QA-fixture branch with
--     zero audit_logs row (fixture created via manage_branch(), then
--     deleted -- synthetic test data only, no real history touched).
--
-- club_memberships' role_id/custom_role_id columns are NOT newly
-- exploitable for escalation -- protect_club_membership_identity_columns()
-- (an existing BEFORE UPDATE trigger, unchanged by this migration)
-- already silently reverts any role_id/custom_role_id/club_id/user_id
-- change that doesn't carry set_staff_role()'s
-- 'mal3aby.role_change_authorized' session flag. LIVE-CONFIRMED this
-- pass: a direct role_id write to the platform_owner role id was
-- silently discarded, membership remained club_owner. Only the
-- non-identity columns (status, has_cash_custody) were the real gap.
--
-- Same fix shape as above: revoke the write policies, keep SELECT.
-- Confirmed zero legitimate direct-write frontend call site exists for
-- either table (grepped `src/` for `.from('branches').(insert|update|
-- upsert|delete)` and the club_memberships equivalent -- zero matches;
-- all real writes already go through manage_branch()/set_staff_role()/
-- set_staff_cash_custody()/deactivate_staff_member()/
-- reactivate_staff_member(), all SECURITY DEFINER, all unaffected by
-- revoking the caller's direct grants).

drop policy if exists branches_write_with_permission on public.branches;
drop policy if exists branches_update_with_permission on public.branches;
drop policy if exists branches_platform_owner_full_access on public.branches;
create policy branches_platform_owner_select on public.branches
  for select
  using (public.is_platform_owner());

drop policy if exists club_memberships_write_with_permission on public.club_memberships;
drop policy if exists club_memberships_update_with_permission on public.club_memberships;
drop policy if exists club_memberships_platform_owner_full_access on public.club_memberships;
create policy club_memberships_platform_owner_select on public.club_memberships
  for select
  using (public.is_platform_owner());
-- club_memberships_platform_support_write (UPDATE, gated on
-- has_platform_support_access(club_id, true)) is intentionally left in
-- place: it's the one legitimate non-RPC write path this table has,
-- used by the Master Admin MANAGE support flow, and is itself already
-- session-scoped/audited/expiring -- a completely different risk shape
-- than the two policies dropped above. Not touched by this migration.

-- SAAS ACCEPTANCE REVIEW -- club staff permissions audit, P0 finding
-- F1 (2026-08-29), the most severe finding of the entire review.
--
-- user_has_branch_access(p_club_id, p_branch_id) unioned branch access
-- across ALL of a caller's active club_memberships rows in a club,
-- instead of resolving the one membership actually governing the
-- current action. If a user holds 2+ active memberships in the same
-- club and even ONE of them is unscoped (zero rows in
-- membership_branches, meaning "all branches"), the function returned
-- true for EVERY branch -- silently voiding the branch restriction on
-- their OTHER, supposedly branch-scoped membership.
--
-- Live-reproduced twice by the security-reviewer subagent:
--   1. baseline: branch_manager membership scoped to Branch A only
--      -> user_has_branch_access(club, branchB) = false (correct)
--   2. grant the SAME user a second, unrelated, unscoped 'scanner'
--      membership on the same club (an entirely ordinary staff-
--      management action, not an exploit)
--      -> user_has_branch_access(club, branchB) = TRUE
--   3. proved end-to-end at the data layer, not just the helper
--      function: a real Branch-B invoice, invisible before, became
--      readable after step 2.
--
-- Blast radius confirmed live: 3 real (club_id, user_id) pairs in
-- production currently hold 2+ active memberships in the same club
-- (0 live victims today since all 3 happen to be unscoped on both
-- memberships already), but the bug activates the instant any
-- multi-membership user receives a branch-scoped role -- an entirely
-- routine staff-management action, not a rare edge case.
--
-- This function backs 18 call sites (RLS policies, RPC guards,
-- triggers) across the whole app -- bookings, cash_shifts, invoices,
-- payments, fields, reschedule_booking, mark_attendance,
-- sell_club_membership, manage_branch, manage_field, and more,
-- including the get_open_cash_shifts/get_shop_inventory_balances
-- branch-scope fix applied earlier in this same review. Fixing this
-- one shared function corrects all of them at once.
--
-- Fix: change the semantics from "ANY membership grants this branch"
-- (a plain exists()/OR across all memberships) to "NO active,
-- explicitly branch-restricted membership excludes this branch" --
-- i.e. AND across memberships, the safe/conservative interpretation.
-- A membership with zero membership_branches rows continues to mean
-- "unrestricted" for that membership specifically (matching
-- has_branch_access()'s existing single-membership semantics,
-- confirmed correct and used as the reference implementation here),
-- but an unrestricted membership can no longer override a sibling
-- restricted membership's scoping.
create or replace function public.user_has_branch_access(p_club_id uuid, p_branch_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select public.is_platform_owner()
    or (
      -- the caller must hold at least one active membership on this
      -- club at all (unchanged precondition from the original logic)
      exists (
        select 1 from public.club_memberships cm
        where cm.user_id = (select auth.uid())
          and cm.club_id = p_club_id
          and cm.status = 'active'
      )
      -- and no active membership that is itself explicitly branch-
      -- restricted may exclude the requested branch. A membership
      -- with zero membership_branches rows is unrestricted and never
      -- excludes anything. p_branch_id is null preserves the ORIGINAL
      -- function's own null-branch semantics exactly: a restricted
      -- membership excludes a null branch (there is no branch row
      -- that can match "branch_id = null"), same as before this fix --
      -- this migration changes ANY-membership-wins to ALL-memberships-
      -- must-agree, it does not change how a single membership treats
      -- a null branch.
      and not exists (
        select 1
        from public.club_memberships cm
        where cm.user_id = (select auth.uid())
          and cm.club_id = p_club_id
          and cm.status = 'active'
          and exists (select 1 from public.membership_branches mb where mb.membership_id = cm.id)
          and not exists (
            select 1 from public.membership_branches mb
            where mb.membership_id = cm.id
              and p_branch_id is not null
              and mb.branch_id = p_branch_id
          )
      )
    )
$function$;

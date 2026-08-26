-- CASH RECONCILIATION & FINANCE OPERATIONS audit -- branch-scope
-- enforcement on report RPCs. Confirmed live: a branch_manager
-- restricted to Branch A could pass p_branch_id=Branch B to
-- get_collections_report (and every other report RPC) and receive a
-- non-error, real response for Branch B -- report.view was checked at
-- the club level only, no report RPC ever called
-- user_has_branch_access(). Systemic across the entire reports domain
-- (grep confirmed zero report RPCs reference it), not finance-specific.
--
-- Fix: a new reusable helper, caller_accessible_branch_ids(), mirroring
-- user_has_branch_access()'s exact unrestricted/restricted logic
-- (membership_branches has no rows for this membership => unrestricted,
-- i.e. every club branch; has rows => exactly those). Returns NULL to
-- mean "unrestricted" (matches this codebase's existing p_branch_id-is-
-- null-means-no-filter convention) and a real array otherwise.
--
-- Every affected report RPC's p_branch_id handling changes from
-- "(p_branch_id is null or col = p_branch_id)" to a scope-aware form:
--   - platform_owner: always unrestricted (matches user_has_branch_
--     access's own is_platform_owner() bypass)
--   - explicit p_branch_id given: reject if not in the caller's
--     accessible set (same generic 'not authorized' pattern used
--     everywhere else in this codebase -- no existence leak)
--   - no p_branch_id given, caller restricted: filter to exactly the
--     caller's accessible branches (never club-wide)
--   - no p_branch_id given, caller unrestricted: unchanged, club-wide
create or replace function public.caller_accessible_branch_ids(p_club_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select case
    when public.is_platform_owner() then null
    when not exists (
      select 1
      from public.club_memberships cm
      join public.membership_branches mb on mb.membership_id = cm.id
      where cm.user_id = auth.uid() and cm.club_id = p_club_id and cm.status = 'active'
    ) then null
    else (
      select array_agg(distinct mb.branch_id)
      from public.club_memberships cm
      join public.membership_branches mb on mb.membership_id = cm.id
      where cm.user_id = auth.uid() and cm.club_id = p_club_id and cm.status = 'active'
    )
  end
$function$;

comment on function public.caller_accessible_branch_ids(uuid) is
  'Returns the set of branch ids the caller is restricted to within this club, or NULL if unrestricted (platform owner, or no membership_branches rows -- matches user_has_branch_access() exactly). Use to enforce report-level branch scope: explicit p_branch_id must be a member of this set (or set is NULL); an absent p_branch_id must filter to this set (or be unfiltered if NULL), never silently return club-wide data to a restricted caller.';

revoke execute on function public.caller_accessible_branch_ids(uuid) from public;
revoke execute on function public.caller_accessible_branch_ids(uuid) from anon;

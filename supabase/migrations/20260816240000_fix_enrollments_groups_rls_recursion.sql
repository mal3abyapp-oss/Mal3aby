-- Gate 4 bug fix, caught via real black-box RPC testing: querying
-- enrollments (even indirectly, as a side effect of evaluating
-- subscriptions_self_service_select) raised "infinite recursion
-- detected in policy for relation enrollments".
--
-- Root cause: a genuine circular RLS dependency introduced across two
-- Gate 3 migrations. enrollments_select (pre-existing, staff/coach
-- policy) references groups.coach_id/assistant_coach_id -- and
-- evaluating a row's visibility in `groups` requires evaluating ALL of
-- groups' own RLS policies, including the Gate 3 addition
-- groups_self_service_select, which itself queries enrollments. So:
-- evaluate enrollments -> evaluate groups -> evaluate enrollments -> ...
--
-- Fix: break the cycle using this codebase's own established
-- SECURITY DEFINER escape hatch for exactly this situation (matching
-- has_branch_access/has_permission/user_club_ids, which all similarly
-- read from RLS-protected tables without re-triggering RLS, because a
-- SECURITY DEFINER function's own table reads bypass the CALLER's RLS
-- context and use the function owner's -- effectively unrestricted
-- inside the function body, but the function itself is still
-- permission-checked before it returns anything).
create or replace function public.is_guardian_of_group(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1 from public.enrollments e
    join public.guardian_links gl on gl.player_id = e.player_id
    join public.customers c on c.id = gl.customer_id
    where e.group_id = p_group_id and c.user_id = auth.uid()
  )
$$;

revoke execute on function public.is_guardian_of_group(uuid) from public, anon;
grant execute on function public.is_guardian_of_group(uuid) to authenticated;

drop policy if exists "groups_self_service_select" on public.groups;
create policy "groups_self_service_select" on public.groups
  for select using (public.is_guardian_of_group(id));

comment on function public.is_guardian_of_group is
  'Breaks a circular RLS dependency between enrollments and groups (enrollments_select checks groups.coach_id, which would otherwise re-evaluate groups_self_service_select, which queried enrollments directly -- infinite recursion). SECURITY DEFINER reads bypass the caller''s own RLS context for the query inside this function body, same escape-hatch pattern as has_permission()/user_club_ids().';

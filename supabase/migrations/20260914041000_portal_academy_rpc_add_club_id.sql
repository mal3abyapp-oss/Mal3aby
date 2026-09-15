-- AUDIT ROUND 2 FINDING #2: PortalAcademyPage.tsx never filtered
-- players/enrollments by the active club, unlike every sibling portal
-- page (PortalBookingsPage/PortalPaymentsPage/PortalQrPage all filter
-- their own RPC's rows by club_id client-side, per PortalClubProvider's
-- own doc comment: "every other Portal screen must filter by
-- customer_id IN (activeCustomerId / customerMemberships[].customerId)").
-- get_my_portal_academy() genuinely never returned a club_id (or
-- customer_id) column at all -- confirmed against its current body
-- (20260831022632_academy_p3_closure_portal_effective_date.sql) -- so a
-- guardian linked to two clubs saw every linked child's enrollments
-- merged together with no way to scope to one club, a real data-mixing
-- bug (not a security/RLS bypass -- the RPC already correctly scopes to
-- c.user_id = auth.uid(), same as before).
--
-- Fix: widen the return table by exactly one column, c.club_id (the
-- SAME customers row already joined via guardian_links in this
-- function's own FROM clause -- no new join, no new table, no WHERE
-- clause change). Body is otherwise byte-for-byte identical to the
-- prior version.
--
-- INTEGRATION FIX (2026-09-14): the original draft used `create or
-- replace function`, which Postgres rejects when a RETURNS TABLE
-- column list changes -- confirmed live via a rolled-back dry-run.
-- Same DROP FUNCTION + CREATE pattern as the sibling
-- get_my_portal_qr_bookings/get_portal_invite_context widenings.
drop function if exists public.get_my_portal_academy();

create function public.get_my_portal_academy()
 returns table(player_id uuid, player_full_name text, player_photo_url text, club_id uuid, enrollment_id uuid, enrollment_status text, group_name text, branch_name text, field_name text, subscription_status text, subscription_end_date date)
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  select p.id, p.full_name, p.photo_url, c.club_id, e.id, e.status, g.name, br.name, f.name,
    s.status,
    -- Effective end date: raw end_date + sum of extends_expiry freeze
    -- durations, computed inline (mirrors get_subscription_effective_
    -- end_date()'s own math exactly, just without that function's
    -- has_permission() gate, which a portal customer can never pass).
    case when s.id is null then null else
      s.end_date + coalesce(
        (select sum(sf.end_date - sf.start_date)::int from public.subscription_freezes sf
         where sf.subscription_id = s.id and sf.extends_expiry = true),
        0
      )
    end
  from public.players p
  join public.guardian_links gl on gl.player_id = p.id
  join public.customers c on c.id = gl.customer_id
  left join public.enrollments e on e.player_id = p.id
  left join public.groups g on g.id = e.group_id
  left join public.branches br on br.id = g.branch_id
  left join public.fields f on f.id = g.field_id
  left join lateral (
    select s2.* from public.subscriptions s2
    where s2.enrollment_id = e.id
    order by s2.created_at desc limit 1
  ) s on true
  where c.user_id = auth.uid();
$function$;

revoke all on function public.get_my_portal_academy() from public, anon;
grant execute on function public.get_my_portal_academy() to authenticated;

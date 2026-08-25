-- PERSONA COUNCIL AUDIT (2026-08-25) -- Customer persona finding:
-- PortalAcademyPage.tsx answered "is my subscription active" but not
-- "until when" or "where do I go". subscription_end_date was already
-- fetched into the frontend's old data model and simply never rendered
-- (a pure UI fix, no schema change needed for that part); branch/field
-- were never fetched at all despite being real, joinable columns on
-- `groups` (branch_id/field_id) -- widening get_my_portal_academy() to
-- include them.
--
-- No schedule/timetable data exists anywhere in this product's data
-- model (`groups` has no day/time columns at all, confirmed against the
-- live schema before making this change) -- that specific customer
-- question genuinely cannot be answered without inventing a new
-- feature, so it stays unaddressed rather than fabricating a display.
--
-- Postgres refuses CREATE OR REPLACE across a RETURNS TABLE column-list
-- change ("cannot change return type of existing function") -- same
-- DROP FUNCTION + CREATE + explicit re-grant pattern as the two other
-- portal RPC widenings earlier in this project's history (20260825100001,
-- 20260825100002), verified live before and after: single overload,
-- authenticated/postgres/service_role only, no anon/public, both times.
-- Same SECURITY DEFINER, customers.user_id = auth.uid()-only body as
-- before -- this widening adds display columns only, the ownership
-- predicate is unchanged.
drop function if exists public.get_my_portal_academy();

create function public.get_my_portal_academy()
returns table (
  player_id uuid,
  player_full_name text,
  player_photo_url text,
  enrollment_id uuid,
  enrollment_status text,
  group_name text,
  branch_name text,
  field_name text,
  subscription_status text,
  subscription_end_date date
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select p.id, p.full_name, p.photo_url, e.id, e.status, g.name, br.name, f.name, s.status, s.end_date
  from public.players p
  join public.guardian_links gl on gl.player_id = p.id
  join public.customers c on c.id = gl.customer_id
  left join public.enrollments e on e.player_id = p.id
  left join public.groups g on g.id = e.group_id
  left join public.branches br on br.id = g.branch_id
  left join public.fields f on f.id = g.field_id
  left join public.subscriptions s on s.enrollment_id = e.id
  where c.user_id = auth.uid();
$function$;

revoke all on function public.get_my_portal_academy() from public, anon;
grant execute on function public.get_my_portal_academy() to authenticated;

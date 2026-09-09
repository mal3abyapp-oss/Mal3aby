-- PLATFORM OWNER OPERATIONAL GAP CLOSURE -- Workstream 2: Sales
-- Intelligence Control (frontend). Item 6 -- "Which demos are
-- scheduled?" is one of the mission's explicit daily-queue questions.
--
-- get_sales_dashboard_summary() already returns a demos_scheduled COUNT
-- (status in demo_scheduled/demo_completed), but no existing RPC
-- returns the actual list of upcoming, not-yet-completed demos with
-- enough detail (business name, scheduled time) to act on -- confirmed
-- by reading that RPC's full return shape (bigint counts only) before
-- adding this. Mirrors get_pending_followups()'s own shape/style
-- exactly (same auth check, same join-to-business_name pattern, same
-- narrow read-only surface) rather than inventing a new pattern.
--
-- Deliberately narrow: only sales_demo_events rows that are still open
-- (completed_at is null) and have a scheduled_at set, ordered soonest
-- first. This is a short list for a dashboard card, not a calendar
-- view -- no new aggregate stats are added here per the mission's own
-- "keep this simple" instruction for item 6.
create or replace function public.get_sales_upcoming_demos(p_limit int default 10)
returns table(
  demo_id uuid,
  lead_id uuid,
  business_name text,
  scheduled_at timestamptz,
  notes text
)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select d.id, d.lead_id, l.business_name, d.scheduled_at, d.notes
  from public.sales_demo_events d
  join public.sales_leads l on l.id = d.lead_id
  where d.completed_at is null
    and d.scheduled_at is not null
    and (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'))
  order by d.scheduled_at
  limit p_limit
$$;

revoke all on function public.get_sales_upcoming_demos(int) from public, anon;
grant execute on function public.get_sales_upcoming_demos(int) to authenticated;

comment on function public.get_sales_upcoming_demos(int) is
  'Read-only list of open (not-yet-completed), scheduled sales demos, soonest first. Narrow companion to get_sales_dashboard_summary()''s demos_scheduled count -- that RPC only returns a count, this one returns the actionable list for a dashboard card.';

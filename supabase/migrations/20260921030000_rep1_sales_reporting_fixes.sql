-- REP-1 (owner brief, live QA 2026-09-19/20): Sales Intelligence
-- reporting investigated end to end before any fix. Three real,
-- evidence-backed gaps closed here:
--
-- 1. Every reporting RPC was all-time cumulative only -- zero date-range
--    parameter anywhere in Sales Intelligence, confirmed by grep across
--    every sales migration. A Platform Owner asking "how did we do this
--    month" had no way to answer that; only "what's the all-time
--    total." The Shop module already has a proven, established pattern
--    for exactly this (p_start_date date default null, p_end_date date
--    default null, `col::date >= p_start_date` filters -- see
--    20260828150000_shop_sales_filters_and_kpis.sql). Copied here
--    verbatim rather than inventing a new convention: get_sales_funnel_
--    stats() and get_sales_dashboard_summary() both gain these two
--    optional params, filtering on sales_leads.first_discovered_at
--    (the same column avg_days_to_conversion already treats as "when
--    this lead entered the pipeline"). Both null (the default) means
--    "all time" -- existing callers are unaffected.
--
-- 2. do_not_contact leads were counted inconsistently between the
--    write-path and read-path halves of this same app: every mutation
--    RPC in this schema actively guards against acting on a
--    do_not_contact lead, but every reporting RPC silently included
--    them in total_leads/the 'discovered' funnel stage while making
--    them invisible in every later stat (they're never hot/warm/cold,
--    never contact_ready, never in the 'contacted' status list) --
--    inflating total_leads relative to every other number on the same
--    card, and making the discovered->qualified drop-off look worse
--    than it really is (a permanently-suppressed lead is not a "stuck"
--    lead). Fixed the cleaner of the two defensible options (excluding
--    do_not_contact from total_leads and every funnel stage, matching
--    how the rest of the app already treats it as inactive) while still
--    giving the owner visibility into how many leads are suppressed:
--    both RPCs gain a new suppressed_count, computed separately, never
--    silently dropped.
--
-- 3. get_sales_stats_by_dimension(p_dimension) -- a fully-built,
--    permission-gated, SQL-injection-safe (format(%I) + whitelist
--    check) RPC -- had ZERO frontend call sites anywhere in src/,
--    confirmed by repo-wide grep. A real, low-risk "finish what's
--    already built" gap, not touched by this migration (no DB change
--    needed) but wired up in the matching frontend commit.
--
-- Explicitly NOT touched here: get_sales_stats_by_source() and
-- get_campaign_stats() are unaffected by the date-range/do_not_contact
-- fixes above -- by-source breakdown and per-campaign stats are
-- lower-frequency, narrower-audience reports where the same fixes would
-- expand scope well beyond what the brief's own evidence calls for;
-- flagged for a separate decision if the owner wants this pattern
-- applied there too, not silently bundled in.

-- New params, even with defaults, create a SEPARATE overload rather
-- than replacing the zero-arg version -- confirmed live during this
-- migration's own dry run (grants query showed get_sales_funnel_stats
-- doubled after a plain CREATE OR REPLACE). Explicit DROP required, not
-- just for a changed return shape (the general rule established
-- earlier in this project) but for a changed PARAMETER LIST too.
drop function if exists public.get_sales_funnel_stats();

create function public.get_sales_funnel_stats(
  p_start_date date default null,
  p_end_date date default null
)
returns table(stage text, lead_count bigint)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    unnest(array['discovered','qualified','contacted','replied','demo_scheduled','won']) as stage,
    unnest(array[
      (select count(*) from public.sales_leads
        where merged_into_lead_id is null and status <> 'do_not_contact'
          and (p_start_date is null or first_discovered_at::date >= p_start_date)
          and (p_end_date is null or first_discovered_at::date <= p_end_date)),
      (select count(*) from public.sales_leads
        where merged_into_lead_id is null and status not in ('discovered','enriching','do_not_contact')
          and (p_start_date is null or first_discovered_at::date >= p_start_date)
          and (p_end_date is null or first_discovered_at::date <= p_end_date)),
      (select count(*) from public.sales_leads
        where merged_into_lead_id is null and status in ('contacted','replied','demo_scheduled','demo_completed','negotiation','won','lost')
          and (p_start_date is null or first_discovered_at::date >= p_start_date)
          and (p_end_date is null or first_discovered_at::date <= p_end_date)),
      (select count(*) from public.sales_leads
        where merged_into_lead_id is null and status in ('replied','demo_scheduled','demo_completed','negotiation','won','lost')
          and (p_start_date is null or first_discovered_at::date >= p_start_date)
          and (p_end_date is null or first_discovered_at::date <= p_end_date)),
      (select count(*) from public.sales_leads
        where merged_into_lead_id is null and status in ('demo_scheduled','demo_completed','negotiation','won')
          and (p_start_date is null or first_discovered_at::date >= p_start_date)
          and (p_end_date is null or first_discovered_at::date <= p_end_date)),
      (select count(*) from public.sales_leads
        where merged_into_lead_id is null and status = 'won'
          and (p_start_date is null or first_discovered_at::date >= p_start_date)
          and (p_end_date is null or first_discovered_at::date <= p_end_date))
    ]) as lead_count
  where public.is_platform_owner() or public.has_platform_permission('platform.sales.view')
$$;

-- New optional trailing params -- CREATE OR REPLACE alone is safe here
-- (no return-shape change, no dropped/reordered params), but re-
-- asserting grants explicitly anyway, matching this session's own
-- established discipline for every migration in this brief.
revoke all on function public.get_sales_funnel_stats(date, date) from public, anon;
grant execute on function public.get_sales_funnel_stats(date, date) to authenticated;

-- Return shape gains a new trailing column (suppressed_count) --
-- CREATE OR REPLACE cannot change a function's RETURNS TABLE column set
-- even when only appending a column (this project's own established,
-- previously-hit defect class -- see 20260909190000_search_sales_leads_
-- add_status_reason.sql's own header for the first occurrence and the
-- exact Postgres error, 42P13). Explicit DROP + CREATE required.
drop function if exists public.get_sales_dashboard_summary();

create function public.get_sales_dashboard_summary(
  p_start_date date default null,
  p_end_date date default null
)
returns table(
  total_leads bigint, hot_leads bigint, warm_leads bigint, cold_leads bigint,
  contact_ready bigint, contacted bigint, demos_scheduled bigint, converted bigint,
  reply_rate numeric, demo_rate numeric, win_rate numeric,
  avg_days_to_conversion numeric, suppressed_count bigint
)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    count(*) filter (where merged_into_lead_id is null and status <> 'do_not_contact') as total_leads,
    count(*) filter (where merged_into_lead_id is null and current_score_band = 'hot') as hot_leads,
    count(*) filter (where merged_into_lead_id is null and current_score_band = 'warm') as warm_leads,
    count(*) filter (where merged_into_lead_id is null and current_score_band = 'cold') as cold_leads,
    count(*) filter (where merged_into_lead_id is null and status = 'contact_ready') as contact_ready,
    count(*) filter (where merged_into_lead_id is null and status in ('contacted','replied','demo_scheduled','demo_completed','negotiation','won','lost')) as contacted,
    count(*) filter (where merged_into_lead_id is null and status in ('demo_scheduled','demo_completed')) as demos_scheduled,
    count(*) filter (where merged_into_lead_id is null and status = 'won') as converted,
    round(
      100.0 * count(*) filter (where merged_into_lead_id is null and status in ('replied','demo_scheduled','demo_completed','negotiation','won','lost'))
      / nullif(count(*) filter (where merged_into_lead_id is null and status in ('contacted','replied','demo_scheduled','demo_completed','negotiation','won','lost')), 0),
      1
    ) as reply_rate,
    round(
      100.0 * count(*) filter (where merged_into_lead_id is null and status in ('demo_scheduled','demo_completed','negotiation','won'))
      / nullif(count(*) filter (where merged_into_lead_id is null and status in ('replied','demo_scheduled','demo_completed','negotiation','won','lost')), 0),
      1
    ) as demo_rate,
    round(
      100.0 * count(*) filter (where merged_into_lead_id is null and status = 'won')
      / nullif(count(*) filter (where merged_into_lead_id is null and status in ('won','lost')), 0),
      1
    ) as win_rate,
    (select round(avg(extract(epoch from (cr.converted_at - l.first_discovered_at)) / 86400.0), 1)
       from public.sales_conversion_records cr join public.sales_leads l on l.id = cr.lead_id
       where (p_start_date is null or l.first_discovered_at::date >= p_start_date)
         and (p_end_date is null or l.first_discovered_at::date <= p_end_date)
    ) as avg_days_to_conversion,
    -- REP-1 fix: previously invisible -- do_not_contact leads counted
    -- in total_leads/'discovered' but nowhere else, with no number
    -- showing how many were suppressed. Now excluded from total_leads
    -- above and surfaced honestly here instead.
    count(*) filter (where merged_into_lead_id is null and status = 'do_not_contact') as suppressed_count
  from public.sales_leads
  where (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'))
    and (p_start_date is null or first_discovered_at::date >= p_start_date)
    and (p_end_date is null or first_discovered_at::date <= p_end_date)
$$;

revoke all on function public.get_sales_dashboard_summary(date, date) from public, anon;
grant execute on function public.get_sales_dashboard_summary(date, date) to authenticated;

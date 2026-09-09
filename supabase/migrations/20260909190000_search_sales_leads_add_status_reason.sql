-- PLATFORM OWNER OPERATIONAL GAP CLOSURE -- Workstream 2: Sales
-- Intelligence Control (frontend). Item 6/item 3 -- "Which leads were
-- lost and why?" is one of the mission's explicit daily-queue
-- questions, and lost-reason capture (item 3) is only useful if it can
-- actually be seen later in the leads list, not only on a single
-- lead's own detail/status-history view.
--
-- search_sales_leads() already accepts p_status='lost' (no new filter
-- needed -- confirmed by reading its full body before this migration),
-- but its RETURN shape never included sales_leads.status_reason, so the
-- existing "lost" filter could show WHICH leads are lost but not WHY.
-- This is a pure additive column addition to the RETURNS TABLE (same
-- function name, same parameter list/signature, only a new trailing
-- output column) -- the PARAMETER signature is unchanged, but Postgres
-- does not allow CREATE OR REPLACE to change a function's RETURNS TABLE
-- column set even when only adding a column (confirmed live against the
-- real schema via a rolled-back transaction: 42P13 "cannot change
-- return type of existing function"), so this requires an explicit
-- DROP FUNCTION IF EXISTS + CREATE FUNCTION, same fix class as
-- get_platform_club_owners/get_platform_audit_log needed in the prior
-- Control Plane V1 mission. No new stat/aggregate RPC is added, per the
-- mission's own "keep this simple" instruction for item 6.
drop function if exists public.search_sales_leads(text, text, text, text, text, int, text, boolean, boolean, boolean, boolean, text, int, int);

create function public.search_sales_leads(
  p_search text default null,
  p_status text default null,
  p_country text default null,
  p_city text default null,
  p_business_type text default null,
  p_min_score int default null,
  p_score_band text default null,
  p_has_website boolean default null,
  p_has_online_booking boolean default null,
  p_uncontacted_only boolean default false,
  p_exclude_do_not_contact boolean default true,
  p_signal_key text default null,
  p_limit int default 50,
  p_offset int default 0
)
returns table(
  lead_id uuid, business_name text, business_type text, city text, country text,
  status text, current_score int, current_score_band text, website text,
  public_phone text, rating numeric, review_count int, first_discovered_at timestamptz,
  total_count bigint, status_reason text
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.view')) then
    raise exception 'not authorized';
  end if;

  return query
  select
    l.id, l.business_name, l.business_type, l.city, l.country,
    l.status, l.current_score, l.current_score_band, l.website,
    l.public_phone, l.rating, l.review_count, l.first_discovered_at,
    count(*) over() as total_count, l.status_reason
  from public.sales_leads l
  where l.merged_into_lead_id is null
    and (p_search is null or l.business_name ilike '%' || p_search || '%' or l.normalized_name ilike '%' || public.sales_normalize_name(p_search) || '%')
    and (p_status is null or l.status = p_status)
    and (p_country is null or l.country = p_country)
    and (p_city is null or l.city = p_city)
    and (p_business_type is null or l.business_type = p_business_type)
    and (p_min_score is null or l.current_score >= p_min_score)
    and (p_score_band is null or l.current_score_band = p_score_band)
    and (p_has_website is null or (p_has_website and l.website is not null) or (not p_has_website and l.website is null))
    and (p_has_online_booking is null or l.has_online_booking = p_has_online_booking)
    and (not p_uncontacted_only or l.status in ('discovered', 'enriching', 'enriched', 'qualified', 'contact_ready'))
    and (not p_exclude_do_not_contact or l.status <> 'do_not_contact')
    and (p_signal_key is null or exists (
      select 1 from public.sales_lead_signals sig where sig.lead_id = l.id and sig.signal_key = p_signal_key and sig.is_active
    ))
  order by l.current_score desc nulls last, l.first_discovered_at desc
  limit p_limit offset p_offset;
end;
$$;

revoke all on function public.search_sales_leads(text, text, text, text, text, int, text, boolean, boolean, boolean, boolean, text, int, int) from public, anon;
grant execute on function public.search_sales_leads(text, text, text, text, text, int, text, boolean, boolean, boolean, boolean, text, int, int) to authenticated;

comment on function public.search_sales_leads(text, text, text, text, text, int, text, boolean, boolean, boolean, boolean, text, int, int) is
  'Additive: now also returns status_reason so a p_status=lost/do_not_contact filter in the frontend can show WHY, not just WHICH leads. Same signature as before -- only the return row shape gained one nullable trailing column.';

-- Sales Intelligence — analytics/dashboard RPCs (ADR-054, Phase 19).
-- All derive from authoritative sales_leads/sales_lead_status_history/
-- sales_conversion_records tables directly, matching this codebase's
-- established "reports derive from authoritative records, not
-- fragile UI-calculated state" convention.

create or replace function public.get_sales_funnel_stats()
returns table(stage text, lead_count bigint)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    unnest(array['discovered','qualified','contacted','replied','demo_scheduled','won']) as stage,
    unnest(array[
      (select count(*) from public.sales_leads where merged_into_lead_id is null),
      (select count(*) from public.sales_leads where merged_into_lead_id is null and status not in ('discovered','enriching')),
      (select count(*) from public.sales_leads where merged_into_lead_id is null and status in ('contacted','replied','demo_scheduled','demo_completed','negotiation','won','lost')),
      (select count(*) from public.sales_leads where merged_into_lead_id is null and status in ('replied','demo_scheduled','demo_completed','negotiation','won','lost')),
      (select count(*) from public.sales_leads where merged_into_lead_id is null and status in ('demo_scheduled','demo_completed','negotiation','won')),
      (select count(*) from public.sales_leads where merged_into_lead_id is null and status = 'won')
    ]) as lead_count
  where public.is_platform_owner() or public.has_platform_permission('platform.sales.view')
$$;

revoke all on function public.get_sales_funnel_stats() from public, anon;
grant execute on function public.get_sales_funnel_stats() to authenticated;

create or replace function public.get_sales_dashboard_summary()
returns table(
  total_leads bigint, hot_leads bigint, warm_leads bigint, cold_leads bigint,
  contact_ready bigint, contacted bigint, demos_scheduled bigint, converted bigint,
  reply_rate numeric, demo_rate numeric, win_rate numeric,
  avg_days_to_conversion numeric
)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    count(*) filter (where merged_into_lead_id is null) as total_leads,
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
       from public.sales_conversion_records cr join public.sales_leads l on l.id = cr.lead_id) as avg_days_to_conversion
  from public.sales_leads
  where public.is_platform_owner() or public.has_platform_permission('platform.sales.view')
$$;

revoke all on function public.get_sales_dashboard_summary() from public, anon;
grant execute on function public.get_sales_dashboard_summary() to authenticated;

create or replace function public.get_sales_stats_by_dimension(p_dimension text)
returns table(dimension_value text, lead_count bigint, won_count bigint)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.view')) then
    raise exception 'not authorized';
  end if;

  if p_dimension not in ('country', 'city', 'business_type') then
    raise exception 'invalid dimension: %', p_dimension;
  end if;

  return query execute format(
    'select coalesce(%1$I, %2$L) as dimension_value, count(*) as lead_count, count(*) filter (where status = %3$L) as won_count
     from public.sales_leads where merged_into_lead_id is null group by %1$I order by count(*) desc limit 50',
    p_dimension, 'unknown', 'won'
  );
end;
$$;

revoke all on function public.get_sales_stats_by_dimension(text) from public, anon;
grant execute on function public.get_sales_stats_by_dimension(text) to authenticated;

create or replace function public.get_sales_stats_by_source()
returns table(source_key text, source_name_en text, lead_count bigint, won_count bigint)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select s.key, s.name_en, count(l.id) as lead_count, count(l.id) filter (where l.status = 'won') as won_count
  from public.sales_lead_sources s
  left join public.sales_leads l on l.primary_source_id = s.id and l.merged_into_lead_id is null
  where public.is_platform_owner() or public.has_platform_permission('platform.sales.view')
  group by s.key, s.name_en
  order by count(l.id) desc
$$;

revoke all on function public.get_sales_stats_by_source() from public, anon;
grant execute on function public.get_sales_stats_by_source() to authenticated;

create or replace function public.get_pending_followups(p_limit int default 50)
returns table(followup_id uuid, lead_id uuid, business_name text, reason text, scheduled_at timestamptz, owner_id uuid, is_overdue boolean)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select f.id, f.lead_id, l.business_name, f.reason, f.scheduled_at, f.owner_id, (f.scheduled_at < now()) as is_overdue
  from public.sales_followups f
  join public.sales_leads l on l.id = f.lead_id
  where f.status = 'pending'
    and (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'))
  order by f.scheduled_at
  limit p_limit
$$;

revoke all on function public.get_pending_followups(int) from public, anon;
grant execute on function public.get_pending_followups(int) to authenticated;

create or replace function public.get_lead_full_profile(p_lead_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_result jsonb;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.view')) then
    raise exception 'not authorized';
  end if;

  select jsonb_build_object(
    'lead', to_jsonb(l),
    'contacts', coalesce((select jsonb_agg(to_jsonb(c)) from public.sales_lead_contacts c where c.lead_id = p_lead_id), '[]'::jsonb),
    'locations', coalesce((select jsonb_agg(to_jsonb(loc)) from public.sales_lead_locations loc where loc.lead_id = p_lead_id), '[]'::jsonb),
    'social_links', coalesce((select jsonb_agg(to_jsonb(sl)) from public.sales_lead_social_links sl where sl.lead_id = p_lead_id), '[]'::jsonb),
    'signals', coalesce((select jsonb_agg(to_jsonb(sig)) from public.sales_lead_signals sig where sig.lead_id = p_lead_id and sig.is_active order by sig.retrieved_at desc), '[]'::jsonb),
    'latest_score', (select to_jsonb(sc) from public.sales_lead_scores sc where sc.lead_id = p_lead_id order by sc.computed_at desc limit 1),
    'notes', coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at desc) from public.sales_lead_notes n where n.lead_id = p_lead_id), '[]'::jsonb),
    'activities', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at desc) from public.sales_lead_activities a where a.lead_id = p_lead_id limit 50), '[]'::jsonb),
    'status_history', coalesce((select jsonb_agg(to_jsonb(sh) order by sh.changed_at desc) from public.sales_lead_status_history sh where sh.lead_id = p_lead_id), '[]'::jsonb),
    'outreach_messages', coalesce((select jsonb_agg(to_jsonb(om) order by om.created_at desc) from public.sales_outreach_messages om where om.lead_id = p_lead_id), '[]'::jsonb),
    'followups', coalesce((select jsonb_agg(to_jsonb(f) order by f.scheduled_at) from public.sales_followups f where f.lead_id = p_lead_id and f.status = 'pending'), '[]'::jsonb),
    'demo_events', coalesce((select jsonb_agg(to_jsonb(d) order by d.created_at desc) from public.sales_demo_events d where d.lead_id = p_lead_id), '[]'::jsonb),
    'possible_duplicates', coalesce((select jsonb_agg(to_jsonb(pd)) from public.sales_possible_duplicates pd where (pd.lead_id_a = p_lead_id or pd.lead_id_b = p_lead_id) and pd.status = 'pending'), '[]'::jsonb)
  ) into v_result
  from public.sales_leads l
  where l.id = p_lead_id;

  if v_result is null then
    raise exception 'lead not found';
  end if;

  return v_result;
end;
$$;

revoke all on function public.get_lead_full_profile(uuid) from public, anon;
grant execute on function public.get_lead_full_profile(uuid) to authenticated;

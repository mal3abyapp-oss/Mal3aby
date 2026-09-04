-- Phase 14: get_lead_full_profile() gains an 'activation_invite' key --
-- the platform owner's lead-detail page needs to know whether a pending
-- invite exists (to show status + enable Resend) without a second
-- round trip. No new grants needed -- same function, same authorization
-- gate, just one more field in the existing jsonb_build_object() call.
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
    'possible_duplicates', coalesce((select jsonb_agg(to_jsonb(pd)) from public.sales_possible_duplicates pd where (pd.lead_id_a = p_lead_id or pd.lead_id_b = p_lead_id) and pd.status = 'pending'), '[]'::jsonb),
    'activation_invite', (
      select jsonb_build_object(
        'status', ai.status,
        'owner_email', ai.owner_email,
        'expires_at', ai.expires_at,
        'created_at', ai.created_at,
        'consumed_at', ai.consumed_at
      )
      from public.sales_tenant_activation_invites ai
      where ai.lead_id = p_lead_id
      order by ai.created_at desc
      limit 1
    )
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

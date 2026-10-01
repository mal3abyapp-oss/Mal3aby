-- Personal WhatsApp Assistant integration (2026-10-01): the Platform
-- Owner's self-hosted n8n + WAHA WhatsApp assistant (separate
-- infrastructure, not part of this app's own deploy -- see
-- mal3aby-whatsapp-assistant-handoff.md for its own full context) needs
-- a way to answer questions like "كام عميل محتمل ساخن النهاردة؟" by
-- querying real Sales Intelligence data.
--
-- The existing get_sales_dashboard_summary() (REP-1,
-- 20260921030000_rep1_sales_reporting_fixes.sql) is NOT reusable here:
-- it is security-definer but its own body still gates on
-- is_platform_owner() OR has_platform_permission(...), both of which
-- resolve via auth.uid() -- null for any service_role-authenticated
-- REST call (n8n has no real Supabase user session, by design: it
-- authenticates with a single static service_role key, never a user
-- JWT). Calling that RPC from n8n would not bypass the check, it would
-- just always evaluate false and raise 'not authorized'.
--
-- Rather than widen an existing, user-facing RPC's auth model (which
-- would risk a real privilege-escalation path for the actual Sales
-- Intelligence UI), this is a NEW, narrow, read-only, service_role-only
-- RPC -- a separate, minimal surface built specifically for this one
-- integration, matching the owner's own explicit choice to scope data
-- to "Sales Intelligence only" (not club-scoped booking/revenue data,
-- which is a materially different, multi-tenant-sensitive surface not
-- part of this request).
create or replace function public.get_sales_summary_for_assistant()
returns table(
  total_leads bigint,
  hot_leads bigint,
  warm_leads bigint,
  contact_ready bigint,
  converted bigint,
  win_rate numeric
)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    count(*) filter (where merged_into_lead_id is null and status <> 'do_not_contact') as total_leads,
    count(*) filter (where merged_into_lead_id is null and current_score_band = 'hot') as hot_leads,
    count(*) filter (where merged_into_lead_id is null and current_score_band = 'warm') as warm_leads,
    count(*) filter (where merged_into_lead_id is null and status = 'contact_ready') as contact_ready,
    count(*) filter (where merged_into_lead_id is null and status = 'won') as converted,
    round(
      100.0 * count(*) filter (where merged_into_lead_id is null and status = 'won')
      / nullif(count(*) filter (where merged_into_lead_id is null and status in ('won','lost')), 0),
      1
    ) as win_rate
  from public.sales_leads
$$;

-- service_role ONLY -- never authenticated/anon/public. This function
-- deliberately has NO internal permission check (unlike every other
-- sales RPC in this schema) because the grant itself is the entire
-- access boundary: only a caller holding the project's service_role key
-- can invoke it at all, and that key is held only by this one trusted
-- n8n integration (never embedded in any client-facing app).
revoke all on function public.get_sales_summary_for_assistant() from public, anon, authenticated;
grant execute on function public.get_sales_summary_for_assistant() to service_role;

comment on function public.get_sales_summary_for_assistant() is
  'Narrow, read-only, service_role-only summary for the Platform Owner''s personal WhatsApp assistant (n8n + WAHA, separate infrastructure). Deliberately does not reuse get_sales_dashboard_summary() -- that RPC''s own auth check depends on auth.uid(), which is null for a service_role REST call, so it would always reject. This function''s only access control is the grant itself.';

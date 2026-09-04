-- MAL3ABY V1 COMMERCIAL PACKAGING -- Step 5: WhatsApp usage visibility
-- for Platform Owner, reusing existing notification_queue data. No
-- numeric quota this release (per mission decision) -- this is purely
-- observability so the Platform Owner can see real per-club WhatsApp
-- volume before any future quota/overage pricing decision is made.

create or replace view public.whatsapp_usage_by_club
with (security_invoker = true) as
select
  nq.club_id,
  c.name_ar as club_name,
  count(*) filter (where nq.created_at > now() - interval '30 days') as messages_last_30d,
  count(*) filter (where nq.created_at > now() - interval '7 days') as messages_last_7d,
  count(*) filter (where nq.created_at > now() - interval '30 days' and nq.status = 'delivered') as delivered_last_30d,
  count(*) filter (where nq.created_at > now() - interval '30 days' and nq.status = 'failed') as failed_last_30d,
  max(nq.created_at) as last_message_at
from public.notification_queue nq
join public.clubs c on c.id = nq.club_id
where nq.channel = 'whatsapp'
group by nq.club_id, c.name_ar;

comment on view public.whatsapp_usage_by_club is
  'Platform-Owner visibility only (security_invoker + RLS on notification_queue/clubs already restrict club-scoped readers to their own club, platform_owner sees all). Deliberately NOT a billing/quota system -- no numeric cap exists this release; this exists to give the Platform Owner real usage data before any future WhatsApp quota/overage pricing decision. See MAL3ABY_V1_COMMERCIAL_PACKAGING.md "WhatsApp policy" section.';

-- Explicit RPC wrapper (in addition to the view) so the Platform Owner
-- UI has one deterministic authorized-only entry point rather than
-- relying solely on RLS-through-a-view, matching the pattern already
-- used for get_commercial_usage/get_founding_offer_status in this
-- release.
create or replace function public.get_whatsapp_usage_platform_wide()
returns setof public.whatsapp_usage_by_club
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select * from public.whatsapp_usage_by_club
  where public.is_platform_owner()
  order by messages_last_30d desc;
$$;

revoke all on function public.get_whatsapp_usage_platform_wide() from public, anon, authenticated;
grant execute on function public.get_whatsapp_usage_platform_wide() to authenticated;

comment on function public.get_whatsapp_usage_platform_wide() is
  'Platform-Owner-only (the WHERE clause returns zero rows for any non-platform-owner caller, matching this codebase''s established defensive-empty-result pattern rather than raising). No new WhatsApp billing infrastructure -- read-only aggregation of existing notification_queue rows.';

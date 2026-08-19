-- Platform Owner directive, Phase E: WhatsApp Platform Health.
--
-- The single largest operational gap the live audit found: zero
-- WhatsApp visibility anywhere in the platform console despite a mature
-- club-level subsystem (whatsapp_accounts, notification_queue) already
-- existing. A platform owner today has no way to know if 10 different
-- clubs all have disconnected WhatsApp accounts short of opening each
-- club's own WhatsApp screen individually.
--
-- This RPC is operational health ONLY -- connection status, queue/
-- failure counts -- never message content. whatsapp_accounts has no
-- message-body column at all (only qr_payload/session_credentials_
-- encrypted, both excluded here), and notification_queue's template_key/
-- variables (which could theoretically carry customer PII shaped like
-- content) are deliberately never selected either -- only status/error/
-- attempt metadata, matching the same shape get_whatsapp_failed_messages()
-- already exposes at the club level, just aggregated across all clubs.
--
-- Batched (one round trip for ALL clubs), never a per-club RPC fan-out --
-- consistent with the Phase A/C precedent (get_platform_clubs_access(),
-- get_platform_club_360()).
create or replace function public.get_platform_whatsapp_health()
returns table(
  club_id uuid,
  club_name text,
  connection_status text,
  connected_phone_masked text,
  last_seen_at timestamptz,
  circuit_breaker_open boolean,
  failed_count_7d bigint,
  pending_count bigint
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  return query
  select
    c.id as club_id,
    c.name_ar as club_name,
    coalesce(wa.status, 'not_connected') as connection_status,
    -- Mask the connected number to the last 4 digits only -- platform
    -- owner needs to confirm SOMETHING is connected, not the full
    -- number of a customer-facing business line.
    case when wa.connected_phone_number is not null
      then '...' || right(wa.connected_phone_number, 4)
      else null
    end as connected_phone_masked,
    wa.last_seen_at,
    (wa.circuit_breaker_open_until is not null and wa.circuit_breaker_open_until > now()) as circuit_breaker_open,
    (select count(*) from public.notification_queue nq
       where nq.club_id = c.id and nq.channel = 'whatsapp' and nq.status = 'failed'
         and nq.created_at > now() - interval '7 days') as failed_count_7d,
    (select count(*) from public.notification_queue nq
       where nq.club_id = c.id and nq.channel = 'whatsapp' and nq.status = 'pending') as pending_count
  from public.clubs c
  left join public.whatsapp_accounts wa on wa.club_id = c.id
  order by c.created_at desc;
end;
$function$;

revoke all on function public.get_platform_whatsapp_health() from public;
revoke all on function public.get_platform_whatsapp_health() from anon;
grant execute on function public.get_platform_whatsapp_health() to authenticated;

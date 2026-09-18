-- Ban-protection hardening follow-up (2026-09-12): widen
-- get_platform_whatsapp_health() to also surface the new
-- restriction_signal_detected_at/restriction_signal_detail evidence
-- fields (added to whatsapp_accounts in 20260912100000), so the
-- Platform Owner's multi-club WhatsApp health overview (and
-- PlatformClubDetailPage.tsx's per-club PlatformWhatsAppCard, which
-- reads this same RPC) can surface a real restriction signal, not just
-- the pre-existing circuit-breaker-open boolean (which reacts to THIS
-- PLATFORM's own send-failure rate, not a WhatsApp-side signal).
--
-- Based on the REAL LIVE function body (confirmed via
-- pg_get_functiondef against production before writing this) -- every
-- pre-existing column, join, and filter preserved verbatim.
drop function if exists public.get_platform_whatsapp_health(uuid);
create function public.get_platform_whatsapp_health(p_club_id uuid default null)
returns table(
  club_id uuid,
  club_name text,
  connection_status text,
  connected_phone_masked text,
  last_seen_at timestamptz,
  circuit_breaker_open boolean,
  failed_count_7d bigint,
  pending_count bigint,
  restriction_signal_detected_at timestamptz,
  restriction_signal_detail text
)
language plpgsql
stable security definer
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
       where nq.club_id = c.id and nq.channel = 'whatsapp' and nq.status = 'pending') as pending_count,
    wa.restriction_signal_detected_at,
    wa.restriction_signal_detail
  from public.clubs c
  left join public.whatsapp_accounts wa on wa.club_id = c.id
  where (p_club_id is not null and c.id = p_club_id)
     or (p_club_id is null and coalesce(c.is_test_fixture, false) = false)
  order by c.created_at desc;
end;
$function$;

revoke all on function public.get_platform_whatsapp_health(uuid) from public, anon;
grant execute on function public.get_platform_whatsapp_health(uuid) to authenticated;

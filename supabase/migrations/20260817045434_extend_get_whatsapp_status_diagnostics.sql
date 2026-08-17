-- Part T: get_whatsapp_status() extended to also expose
-- circuit_breaker_open_until / circuit_breaker_reason /
-- last_successful_send_at (all added to whatsapp_accounts in
-- 20260818030000/20260818050000) -- MessagingSafetyCard.tsx's
-- diagnostics section currently hardcodes these to null because the
-- RPC never returned them. Never exposes anything beyond these three
-- safe, non-secret columns -- no session credentials, no QR payload
-- (that stays on the separate get_whatsapp_qr() RPC, unchanged).
--
-- Return signature is changing (3 new columns), so the function must
-- be dropped and recreated -- `create or replace` cannot alter a
-- function's OUT parameter list in Postgres.
drop function if exists public.get_whatsapp_status(uuid);

create function public.get_whatsapp_status(p_club_id uuid)
returns table(
  status text,
  connected_phone_number text,
  connected_at timestamptz,
  last_seen_at timestamptz,
  last_error text,
  qr_expires_at timestamptz,
  circuit_breaker_open_until timestamptz,
  circuit_breaker_reason text,
  last_successful_send_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_connection', p_club_id)) then
    raise exception 'not authorized';
  end if;

  return query
    select wa.status, wa.connected_phone_number, wa.connected_at, wa.last_seen_at, wa.last_error, wa.qr_expires_at,
           wa.circuit_breaker_open_until, wa.circuit_breaker_reason, wa.last_successful_send_at
    from public.whatsapp_accounts wa
    where wa.club_id = p_club_id;
end;
$$;

revoke execute on function public.get_whatsapp_status(uuid) from public, anon;
grant execute on function public.get_whatsapp_status(uuid) to authenticated;

comment on function public.get_whatsapp_status(uuid) is 'Club-facing (auth.uid() + manage_whatsapp_connection permission required). Extended for Part T diagnostics: circuit_breaker_open_until/circuit_breaker_reason/last_successful_send_at, alongside the original status/phone/timestamps/error fields. Still never exposes session_credentials_encrypted or qr_payload (qr_payload stays on the separate get_whatsapp_qr() RPC).';

-- SECURITY/HYGIENE FIX (confirmed live): a WhatsApp-invalidated session
-- (operator-initiated disconnect, or the phone removing the linked
-- device) transitions whatsapp_accounts.status to 'logged_out' via
-- whatsapp_connector_report_status(), but the encrypted session blob
-- (session_credentials_encrypted) was never cleared on that transition.
-- A prior migration's own comment (20260817110000, "the connector...
-- clears session_credentials_encrypted via
-- whatsapp_connector_clear_session() once it has done so") documents
-- this as the intended design -- that function was never actually
-- created (confirmed by full-repo search, zero matches beyond the one
-- comment referencing it), so the documented cleanup never happened.
--
-- Consequence, confirmed by reading whatsapp_connector_list_accounts()'s
-- own filter (`session_credentials_encrypted is not null or
-- status = 'connecting'`): a stale, WhatsApp-invalidated encrypted
-- session is not excluded by that filter, so on every connector restart
-- it gets decrypted and a doomed reconnect() is attempted against
-- credentials WhatsApp has already revoked. This never produces a false
-- "connected" UI state (the frontend correctly still shows logged_out
-- and requires a fresh QR -- confirmed by reading BaileysProvider's own
-- disconnect-reason handling, which unconditionally sets 'logged_out'
-- for both an explicit operator disconnect and a loggedOut disconnect
-- reason, with no auto-reconnect branch reachable from that state) --
-- it is a residual-secret-hygiene gap and a wasted-retry issue.
--
-- Fix: whatsapp_connector_report_status() now nulls
-- session_credentials_encrypted whenever a transition lands on
-- 'logged_out', in the same UPDATE that already clears
-- connected_phone_number/connected_at for that status. No new RPC
-- needed -- this is the one place the connector already reports this
-- exact transition. 'disconnected' (the operator-initiated intent,
-- set by disconnect_whatsapp() before the connector has reacted) is
-- deliberately left untouched here: the connector's own logout() always
-- reports 'logged_out' shortly after, which is where the real
-- credential invalidation has actually happened.

create or replace function public.whatsapp_connector_report_status(
  p_club_id uuid,
  p_status text,
  p_qr_payload text default null,
  p_qr_ttl_seconds integer default null,
  p_connected_phone_number text default null,
  p_error text default null,
  p_generation integer default 0,
  p_state_seq integer default 0
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_current_generation integer;
  v_current_state_seq integer;
begin
  if p_status not in (
    'disconnected', 'qr_required', 'connecting', 'connected',
    'reconnecting', 'degraded', 'logged_out', 'restricted', 'failed', 'error'
  ) then
    raise exception 'invalid status';
  end if;

  select last_generation, last_state_seq into v_current_generation, v_current_state_seq
  from public.whatsapp_accounts
  where club_id = p_club_id
  for update;

  if v_current_generation is not null then
    if p_generation < v_current_generation
      or (p_generation = v_current_generation and p_state_seq <= v_current_state_seq)
    then
      insert into public.whatsapp_connection_events (club_id, event, actor_id, detail)
      values (p_club_id, 'status_write_rejected_stale', null, jsonb_build_object(
        'attempted_status', p_status,
        'attempted_generation', p_generation,
        'attempted_state_seq', p_state_seq,
        'current_generation', v_current_generation,
        'current_state_seq', v_current_state_seq
      ));
      return;
    end if;
  end if;

  insert into public.whatsapp_accounts (club_id, status, last_generation, last_state_seq)
  values (p_club_id, p_status, p_generation, p_state_seq)
  on conflict (club_id) do update set
    status = p_status,
    qr_payload = case when p_status = 'qr_required' then p_qr_payload else null end,
    qr_expires_at = case when p_status = 'qr_required' and p_qr_ttl_seconds is not null then now() + make_interval(secs => p_qr_ttl_seconds) else null end,
    connected_phone_number = case when p_status = 'connected' then coalesce(p_connected_phone_number, public.whatsapp_accounts.connected_phone_number) when p_status in ('disconnected', 'logged_out') then null else public.whatsapp_accounts.connected_phone_number end,
    connected_at = case when p_status = 'connected' and public.whatsapp_accounts.connected_at is null then now() when p_status in ('disconnected', 'logged_out') then null else public.whatsapp_accounts.connected_at end,
    last_seen_at = case when p_status = 'connected' then now() else public.whatsapp_accounts.last_seen_at end,
    last_error = p_error,
    last_generation = p_generation,
    last_state_seq = p_state_seq,
    -- The actual fix: purge the encrypted session on a confirmed logout
    -- so no stale, WhatsApp-invalidated credential material lingers in
    -- Postgres or gets decrypted/retried on a future connector restart.
    session_credentials_encrypted = case when p_status = 'logged_out' then null else public.whatsapp_accounts.session_credentials_encrypted end,
    updated_at = now();

  insert into public.whatsapp_connection_events (club_id, event, actor_id, detail)
  values (p_club_id, 'status_' || p_status, null, jsonb_build_object('error', p_error, 'generation', p_generation, 'state_seq', p_state_seq));
end;
$function$;

-- Status-write-race fix (2026-08-18).
--
-- ROOT CAUSE (proven): TenantConnectionManager.onStateChange fires
-- `void this.sync.reportStatus(...)` fire-and-forget, with no await and
-- no ordering guarantee between concurrent Supabase RPC calls. The old
-- whatsapp_connector_report_status was an unconditional UPDATE with
-- zero fencing -- a late-arriving stale write (e.g. an old
-- "disconnected" report from a rapid connect/disconnect/reconnect
-- flicker, confirmed to occur in production via
-- whatsapp_connection_events, e.g. two status_connected/
-- status_disconnected pairs under 1s apart for club
-- b9178c0f-00b5-4c71-abec-b8772ffb8682 around 2026-08-18 16:43-16:47)
-- could complete its RPC call AFTER a newer "connected" report, leaving
-- whatsapp_accounts.status stuck disconnected while the real Baileys
-- provider was already healthy -- which then caused
-- whatsapp_connector_claim_next_batch()'s `wa.status = 'connected'`
-- eligibility filter to incorrectly exclude a genuinely connected
-- account, starving its queue.
--
-- FIX (minimal, correct for a single-process-per-club architecture --
-- no distributed coordination needed, since fencing only needs to order
-- writes from ONE process's own sequential state machine): every status
-- write now carries a (generation, state_seq) pair.
--   - generation: already existed in BaileysProvider, bumps only on a
--     real Baileys reconnect (new socket).
--   - state_seq: NEW, bumps on every single setState() call within a
--     generation, monotonic for the life of the process.
-- whatsapp_connector_report_status now rejects (and logs a
-- status_write_rejected_stale connection event, without mutating
-- anything) any write whose (generation, state_seq) is not strictly
-- newer than what is already stored -- newer generation always wins
-- regardless of state_seq (a fresh reconnect resets state_seq to a
-- small number and must still be able to overwrite an old
-- generation's larger state_seq); within the same generation, only a
-- strictly larger state_seq is accepted.
--
-- Adversarially proven (against a disposable test club, no production
-- data touched): (1) a stale same-generation write with a lower
-- state_seq is rejected, row unchanged; (2) an exact-replay
-- (generation, state_seq) resubmit is also rejected, not silently
-- reapplied; (3) a genuine new-generation write is accepted even with a
-- state_seq lower than the previous generation's, because generation is
-- compared before state_seq.

alter table public.whatsapp_accounts
  add column if not exists last_generation integer not null default 0,
  add column if not exists last_state_seq integer not null default 0;

comment on column public.whatsapp_accounts.last_generation is
  'Status-write-race fencing: the (generation, last_state_seq) of the last ACCEPTED status write for this club. Bumps only on a real Baileys reconnect. See whatsapp_connector_report_status().';
comment on column public.whatsapp_accounts.last_state_seq is
  'Status-write-race fencing: monotonic per-generation sequence of the last ACCEPTED status write for this club. Bumps on every BaileysProvider.setState() call. See whatsapp_connector_report_status().';

drop function if exists public.whatsapp_connector_report_status(uuid, text, text, integer, text, text);

create function public.whatsapp_connector_report_status(
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
    updated_at = now();

  insert into public.whatsapp_connection_events (club_id, event, actor_id, detail)
  values (p_club_id, 'status_' || p_status, null, jsonb_build_object('error', p_error, 'generation', p_generation, 'state_seq', p_state_seq));
end;
$function$;

-- Service-role-only, same pattern as every other whatsapp_connector_*
-- RPC -- explicitly naming anon/authenticated (not relying on the
-- `public` pseudo-role alone, which does not strip their separate
-- grants -- see the accompanying grant-leak fix migration for the two
-- other functions this same pitfall affected).
revoke all on function public.whatsapp_connector_report_status(uuid, text, text, integer, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.whatsapp_connector_report_status(uuid, text, text, integer, text, text, integer, integer) to service_role;

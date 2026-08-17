-- Task #94 (Local Baileys Node connector service). The connector needs
-- a way to (a) discover which pending notification_queue rows are for
-- the 'whatsapp' channel and (b) report the outcome of a send attempt,
-- without ever touching notification_queue directly (same "narrow
-- purpose-built RPC over broad table grants" principle as the
-- whatsapp_connector_* RPCs added in 20260817110000). The connector
-- authenticates with the Supabase service-role key -- these RPCs are
-- deliberately NOT granted to authenticated/anon, matching that
-- migration's convention.
--
-- Retry policy: bounded exponential-ish backoff (1m, 5m, 20m, 60m),
-- capped at 5 attempts total -- after that the row is left in 'failed'
-- (terminal) rather than 'retrying' forever, per the directive's
-- explicit "no fast infinite loop, no lost bookings/payments, but also
-- no infinite retry storm" requirement. A club that reconnects WhatsApp
-- after a failed row's cap is exhausted does not automatically get it
-- resent -- that is a deliberate, conservative default (avoids
-- surprise duplicate sends long after the fact); operators can see
-- failed rows via the existing notification_queue_select_own_club
-- policy.

create or replace function public.whatsapp_connector_claim_next_batch(p_limit integer default 10)
returns table(
  id uuid,
  club_id uuid,
  recipient_customer_id uuid,
  recipient_phone text,
  template_key text,
  language text,
  variables jsonb,
  attempts int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
    with claimed as (
      select nq.id
      from public.notification_queue nq
      where nq.channel = 'whatsapp'
        and nq.status in ('pending', 'retrying')
        and nq.scheduled_at <= now()
        and (nq.next_attempt_at is null or nq.next_attempt_at <= now())
        and (nq.expires_at is null or nq.expires_at > now())
      order by nq.scheduled_at
      limit greatest(p_limit, 0)
      for update skip locked
    )
    update public.notification_queue nq
    set status = 'processing',
        last_attempt_at = now(),
        attempts = nq.attempts + 1
    from claimed
    where nq.id = claimed.id
    returning
      nq.id, nq.club_id, nq.recipient_customer_id,
      coalesce(nq.recipient_phone, (select c.normalized_mobile from public.customers c where c.id = nq.recipient_customer_id)),
      nq.template_key, nq.language, nq.variables, nq.attempts;
end;
$$;

revoke execute on function public.whatsapp_connector_claim_next_batch(integer) from public, anon, authenticated;

comment on function public.whatsapp_connector_claim_next_batch(integer) is
  'Connector-only (service-role): atomically claims up to p_limit pending/retrying whatsapp queue rows (FOR UPDATE SKIP LOCKED so multiple connector instances/restarts never double-claim the same row) and flips them to processing. Resolves recipient phone from the customer record when recipient_phone was not set directly on the queue row.';

create or replace function public.whatsapp_connector_report_send_result(
  p_queue_id uuid,
  p_success boolean,
  p_provider_reference text default null,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempts int;
  v_max_attempts constant int := 5;
  v_backoff_minutes int;
begin
  if p_success then
    update public.notification_queue
    set status = 'sent',
        provider_reference = p_provider_reference,
        last_error = null
    where id = p_queue_id;
    return;
  end if;

  select attempts into v_attempts from public.notification_queue where id = p_queue_id;
  if v_attempts is null then
    return; -- unknown row -- nothing to do, never raise on a stale/foreign id
  end if;

  if v_attempts >= v_max_attempts then
    update public.notification_queue
    set status = 'failed', last_error = p_error
    where id = p_queue_id;
    return;
  end if;

  v_backoff_minutes := case v_attempts
    when 1 then 1
    when 2 then 5
    when 3 then 20
    else 60
  end;

  update public.notification_queue
  set status = 'retrying',
      last_error = p_error,
      next_attempt_at = now() + make_interval(mins => v_backoff_minutes)
  where id = p_queue_id;
end;
$$;

revoke execute on function public.whatsapp_connector_report_send_result(uuid, boolean, text, text) from public, anon, authenticated;

comment on function public.whatsapp_connector_report_send_result(uuid, boolean, text, text) is
  'Connector-only (service-role): reports the outcome of one send attempt. Success -> sent (terminal). Failure -> retrying with capped exponential-ish backoff (1m/5m/20m/60m) up to 5 total attempts, then failed (terminal) -- never an infinite retry loop.';

-- The connector also needs template bodies to render (Section 20:
-- centralized template layer, not text scattered in the connector).
-- Templates live in application code (task #96), not the DB, so no
-- table is added here -- the connector receives template_key +
-- variables from the claim above and renders using its own template
-- module, mirroring how the rest of this app keeps display strings in
-- code + i18n resources rather than in the database.

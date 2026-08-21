-- Git-history reconciliation, not a behavior change. Confirmed via
-- direct pg_get_functiondef inspection that the LIVE
-- whatsapp_connector_report_send_result() already contains the complete
-- circuit-breaker logic (opens circuit_breaker_open_until when a club's
-- recent WhatsApp failure rate crosses messaging_safety_settings'
-- threshold over a rolling window, logs a whatsapp_connection_events
-- row) -- this logic was present in the original
-- 20260817044244_safe_messaging_rate_control_circuit_breaker.sql,
-- dropped when 20260818010000_whatsapp_connector_queue_rpcs.sql
-- redefined the same function without it, then evidently restored
-- directly against the live database at some point with no
-- corresponding migration file ever committed (the same class of
-- git/DB drift documented and reconciled for SP-001 earlier in this
-- engagement). This migration is an idempotent CREATE OR REPLACE of the
-- exact function body already live -- applying it changes nothing,
-- it only makes migration history match reality so a future
-- `supabase db reset`/fresh-environment rebuild produces the correct
-- behavior instead of the July regression.

create or replace function public.whatsapp_connector_report_send_result(
  p_queue_id uuid,
  p_success boolean,
  p_provider_reference text default null,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_attempts int;
  v_max_attempts constant int := 5;
  v_backoff_minutes int;
  v_club_id uuid;
  v_settings record;
  v_window_start timestamptz;
  v_total int;
  v_failed int;
  v_failure_rate numeric;
begin
  select club_id into v_club_id from public.notification_queue where id = p_queue_id;
  if v_club_id is null then
    return;
  end if;

  if p_success then
    update public.notification_queue
    set status = 'sent',
        provider_reference = p_provider_reference,
        last_error = null
    where id = p_queue_id;

    update public.whatsapp_accounts
    set last_successful_send_at = now()
    where club_id = v_club_id;
  else
    select attempts into v_attempts from public.notification_queue where id = p_queue_id;

    if v_attempts >= v_max_attempts then
      update public.notification_queue
      set status = 'failed', last_error = p_error
      where id = p_queue_id;
    else
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
    end if;
  end if;

  select circuit_breaker_enabled, circuit_breaker_failure_rate_threshold,
         circuit_breaker_min_sample_size, circuit_breaker_window_minutes,
         circuit_breaker_cooldown_minutes
  into v_settings
  from public.messaging_safety_settings
  where club_id = v_club_id;

  if v_settings is not null and v_settings.circuit_breaker_enabled then
    v_window_start := now() - make_interval(mins => v_settings.circuit_breaker_window_minutes);

    select count(*), count(*) filter (where status = 'failed' and last_attempt_at > v_window_start)
    into v_total, v_failed
    from public.notification_queue
    where channel = 'whatsapp'
      and club_id = v_club_id
      and last_attempt_at > v_window_start
      and status in ('sent', 'failed');

    if v_total >= v_settings.circuit_breaker_min_sample_size then
      v_failure_rate := v_failed::numeric / v_total::numeric;
      if v_failure_rate >= v_settings.circuit_breaker_failure_rate_threshold then
        update public.whatsapp_accounts
        set circuit_breaker_open_until = now() + make_interval(mins => v_settings.circuit_breaker_cooldown_minutes),
            circuit_breaker_reason = format(
              'failure rate %s%% over last %s minute(s), %s of %s sends failed',
              round(v_failure_rate * 100), v_settings.circuit_breaker_window_minutes, v_failed, v_total
            )
        where club_id = v_club_id
          and (circuit_breaker_open_until is null or circuit_breaker_open_until <= now());

        insert into public.whatsapp_connection_events (club_id, event, actor_id, detail)
        select v_club_id, 'circuit_breaker_opened', null,
               jsonb_build_object('failure_rate', v_failure_rate, 'failed', v_failed, 'total', v_total)
        where exists (
          select 1 from public.whatsapp_accounts
          where club_id = v_club_id and circuit_breaker_open_until > now()
        );
      end if;
    end if;
  end if;
end;
$function$;

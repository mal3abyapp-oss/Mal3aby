-- INDEPENDENT ACCEPTANCE AUDIT reconciliation (2026-08-21, second pass).
-- Two real, confirmed-live findings from an independent adversarial
-- re-audit of the WhatsApp hardening phase, neither part of the
-- original 7-migration set:
--
-- 1. GIT AHEAD OF LIVE (rebuildability gap, not a live security hole):
--    whatsapp_connector_upsert_incident() and
--    whatsapp_connector_write_delivery_trace() exist live with correct
--    service_role-only grants (already fixed by
--    20260818191000_fix_whatsapp_observability_rpc_public_grant_leak.sql,
--    whose own comment admits these two functions were originally
--    created directly against the database in an earlier session,
--    never via a CREATE OR REPLACE FUNCTION migration). A fresh
--    `supabase db reset` from migration history alone would NOT
--    recreate either function's actual body -- only its grant would be
--    (harmlessly) revoked from a function that was never created.
--    This migration is a pure idempotent CREATE OR REPLACE reconciling
--    git to match the live, already-correct implementation. No
--    behavior change.
--
-- 2. Grant hygiene (confirmed NOT independently exploitable, fixed as
--    defense-in-depth to match this project's own established
--    pattern): notification_source_still_valid() never had its default
--    PUBLIC execute grant revoked. Live-tested directly: this function
--    is NOT security definer (runs as caller, inheriting the caller's
--    own RLS), and bookings/payments both have RLS enabled+forced --
--    confirmed live that querying a real cross-tenant booking (both a
--    genuinely 'cancelled' one and a genuinely 'checked_in' one, from
--    a different club than the caller) returns identically `false` in
--    both cases, because RLS silently hides the row from the
--    unauthorized caller entirely (v_status ends up null either way) --
--    it does NOT distinguish or leak the real status to an
--    unauthorized caller. Not exploitable for information disclosure.
--    Grant tightened anyway for consistency.

create or replace function public.whatsapp_connector_upsert_incident(
  p_club_id uuid,
  p_outcome text,
  p_root_cause_code text,
  p_root_cause_confidence text,
  p_automatic_recovery_performed boolean default false,
  p_automatic_recovery_detail text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_incident_id uuid;
  v_severity text;
  v_recent_failure_count int;
begin
  if p_outcome = 'success' then
    update public.whatsapp_incidents
    set status = 'resolved',
        resolved_at = now(),
        first_successful_send_after_fix_at = coalesce(first_successful_send_after_fix_at, now()),
        updated_at = now()
    where club_id = p_club_id and status <> 'resolved'
    returning id into v_incident_id;

    return v_incident_id;
  end if;

  select count(*) into v_recent_failure_count
  from public.whatsapp_delivery_traces
  where club_id = p_club_id
    and outcome in ('failed', 'timed_out')
    and created_at > now() - interval '10 minutes';

  if v_recent_failure_count < 3 then
    return null;
  end if;

  v_severity := case p_root_cause_code
    when 'SESSION_LOGGED_OUT' then 'critical'
    when 'RECONNECT_EXHAUSTED' then 'critical'
    when 'PROCESS_UNCAUGHT_EXCEPTION' then 'critical'
    when 'QR_GENERATION_FAILED' then 'warning'
    when 'PDF_GENERATION_FAILED' then 'warning'
    when 'CIRCUIT_BREAKER_OPEN' then 'warning'
    when 'CONTAINER_RESTART' then 'info'
    else 'high'
  end;

  select id into v_incident_id
  from public.whatsapp_incidents
  where club_id = p_club_id and status <> 'resolved'
  order by started_at desc
  limit 1;

  if v_incident_id is not null then
    update public.whatsapp_incidents
    set affected_message_count = affected_message_count + 1,
        root_cause_code = p_root_cause_code,
        root_cause_confidence = p_root_cause_confidence,
        automatic_recovery_performed = automatic_recovery_performed or p_automatic_recovery_performed,
        automatic_recovery_detail = coalesce(p_automatic_recovery_detail, automatic_recovery_detail),
        status = case when p_automatic_recovery_performed then 'recovering' else status end,
        updated_at = now()
    where id = v_incident_id;
  else
    insert into public.whatsapp_incidents (
      club_id, severity, root_cause_code, root_cause_confidence,
      affected_message_count, automatic_recovery_performed, automatic_recovery_detail,
      manual_action_required
    )
    values (
      p_club_id, v_severity, p_root_cause_code, p_root_cause_confidence,
      v_recent_failure_count, p_automatic_recovery_performed, p_automatic_recovery_detail,
      v_severity = 'critical'
    )
    returning id into v_incident_id;
  end if;

  return v_incident_id;
end;
$function$;

revoke all on function public.whatsapp_connector_upsert_incident(uuid, text, text, text, boolean, text) from public, anon, authenticated;
grant execute on function public.whatsapp_connector_upsert_incident(uuid, text, text, text, boolean, text) to service_role;

create or replace function public.whatsapp_connector_write_delivery_trace(
  p_club_id uuid,
  p_notification_queue_id uuid,
  p_attempt_number integer,
  p_template_key text,
  p_media_type text,
  p_media_intent text,
  p_socket_generation integer,
  p_container_instance_id text,
  p_stage_timeline jsonb,
  p_last_stage_reached text,
  p_started_at timestamp with time zone,
  p_finished_at timestamp with time zone,
  p_elapsed_ms integer,
  p_outcome text,
  p_root_cause_code text,
  p_root_cause_confidence text,
  p_error_summary text,
  p_has_provider_reference boolean
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_trace_id uuid;
begin
  insert into public.whatsapp_delivery_traces (
    club_id, notification_queue_id, attempt_number, template_key,
    media_type, media_intent, socket_generation, container_instance_id,
    stage_timeline, last_stage_reached, started_at, finished_at,
    elapsed_ms, outcome, root_cause_code, root_cause_confidence,
    error_summary, has_provider_reference
  )
  values (
    p_club_id, p_notification_queue_id, p_attempt_number, p_template_key,
    p_media_type, p_media_intent, p_socket_generation, p_container_instance_id,
    coalesce(p_stage_timeline, '[]'::jsonb), p_last_stage_reached, p_started_at, p_finished_at,
    p_elapsed_ms, p_outcome, p_root_cause_code, p_root_cause_confidence,
    left(p_error_summary, 500), p_has_provider_reference
  )
  returning id into v_trace_id;

  return v_trace_id;
end;
$function$;

revoke all on function public.whatsapp_connector_write_delivery_trace(uuid, uuid, integer, text, text, text, integer, text, jsonb, text, timestamptz, timestamptz, integer, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.whatsapp_connector_write_delivery_trace(uuid, uuid, integer, text, text, text, integer, text, jsonb, text, timestamptz, timestamptz, integer, text, text, text, text, boolean) to service_role;

revoke execute on function public.notification_source_still_valid(text, uuid, text) from public, anon, authenticated;

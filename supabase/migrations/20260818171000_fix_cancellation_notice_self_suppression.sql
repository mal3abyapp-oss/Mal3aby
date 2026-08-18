-- REAL P1 BUG found live during MAL3ABY FINAL PRODUCTION HARDENING's
-- WhatsApp QR Cancellation Test: cancel_booking() calls
-- cancel_pending_whatsapp_for_booking(p_booking_id) AFTER emitting its
-- OWN new booking.cancelled notification -- but that function's WHERE
-- clause only filters by (reference_id = p_booking_id AND status IN
-- ('pending','retrying')), with no exclusion for the specific queue
-- row cancel_booking() itself just inserted moments earlier in the
-- SAME transaction. Since a freshly-queued notification is always
-- status='pending', the cancellation notice unconditionally matched
-- its own suppression sweep and was marked 'cancelled' before the
-- connector ever had a chance to claim it.
--
-- Confirmed live: booking 093e89a7-8fdc-488f-b9e9-df6808b22436 was
-- cancelled via the real cancel_booking() RPC; its booking.cancelled
-- notification_queue row (id c25d5189-683a-454f-98e2-abfdd1c40d76)
-- read status='cancelled' with zero send attempts immediately after
-- cancel_booking() returned -- the WhatsApp cancellation message was
-- never sent, for every cancellation since this mechanism shipped
-- (20260817045250_wire_cancellation_suppression_into_cancel_booking.sql).
--
-- Fix: cancel_pending_whatsapp_for_booking() now accepts an optional
-- p_exclude_event_id parameter. cancel_booking() passes its own
-- v_event_id so the just-created cancellation notice is explicitly
-- excluded from the sweep -- every OTHER still-pending/retrying row
-- for this booking (e.g. a booking-confirmed notice queued moments
-- earlier and not yet claimed) is still correctly suppressed, which
-- was the original, correct intent of this function.

create or replace function public.cancel_pending_whatsapp_for_booking(p_booking_id uuid, p_exclude_event_id uuid default null)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with cancelled as (
    update public.notification_queue nq
    set status = 'cancelled'
    from public.notification_events ne
    where nq.event_id = ne.id
      and ne.reference_type = 'booking'
      and ne.reference_id = p_booking_id
      and nq.channel = 'whatsapp'
      and nq.status in ('pending', 'retrying')
      and (p_exclude_event_id is null or ne.id != p_exclude_event_id)
    returning nq.id
  )
  select count(*)::integer from cancelled;
$$;

revoke execute on function public.cancel_pending_whatsapp_for_booking(uuid, uuid) from public, anon, authenticated;

comment on function public.cancel_pending_whatsapp_for_booking(uuid, uuid) is 'Part K, fixed 20260818: marks any OTHER still-pending/retrying whatsapp queue row tied to this booking as cancelled -- p_exclude_event_id lets the caller exclude its own just-emitted notification event so a cancellation notice never suppresses itself (real P1 bug found live: this self-suppression previously meant NO booking-cancellation WhatsApp message was ever actually sent). Internal-only.';

-- Re-wire cancel_booking() to pass its own v_event_id as the
-- exclusion. Full body otherwise unchanged from
-- 20260817045250_wire_cancellation_suppression_into_cancel_booking.sql.
create or replace function public.cancel_booking(p_booking_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_customer_id uuid;
  v_field_id uuid;
  v_field_name text;
  v_start_at timestamptz;
  v_event_id uuid;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a cancellation reason is required';
  end if;

  select club_id, customer_id, field_id, start_at into v_club_id, v_customer_id, v_field_id, v_start_at
  from public.bookings where id = p_booking_id;
  if v_club_id is null then
    raise exception 'booking not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('booking.cancel', v_club_id)) then
    raise exception 'not authorized';
  end if;

  update public.bookings
  set status = 'cancelled', cancelled_reason = p_reason, cancelled_by = auth.uid(), cancelled_at = now()
  where id = p_booking_id and status in ('pending_payment', 'confirmed');

  if not found then
    raise exception 'booking not found or not in a cancellable state';
  end if;

  perform public.write_audit_log(v_club_id, 'cancel_booking', 'bookings', p_booking_id, null, jsonb_build_object('status', 'cancelled'), p_reason);

  select name into v_field_name from public.fields where id = v_field_id;

  v_event_id := public.emit_notification_event(
    v_club_id, 'booking.cancelled', 'booking', p_booking_id,
    jsonb_build_object('customer_id', v_customer_id, 'reason', p_reason, 'start_at', v_start_at)
  );

  perform public.queue_whatsapp_notification(
    v_club_id, v_event_id, v_customer_id, 'booking-cancelled', 'booking_confirmations',
    jsonb_build_object('field_name', coalesce(v_field_name, ''), 'start_at', v_start_at, 'reason', p_reason),
    'transactional', 'booking.cancelled:' || p_booking_id::text
  );

  -- FIXED: exclude this cancellation event's own queue row from the
  -- sweep, so it no longer suppresses itself. Still correctly
  -- suppresses any OTHER pending/retrying row for this booking.
  perform public.cancel_pending_whatsapp_for_booking(p_booking_id, v_event_id);
end;
$$;

revoke execute on function public.cancel_booking(uuid, text) from public;

-- The 1-arg cancel_pending_whatsapp_for_booking(uuid) overload is now
-- dead code -- cancel_booking() (its only real caller, confirmed via
-- repo-wide grep) always calls the 2-arg form above. Dropping it
-- removes the trap of a future caller accidentally invoking the old
-- self-suppressing version.
drop function if exists public.cancel_pending_whatsapp_for_booking(uuid);

-- Part K: wire cancel_pending_whatsapp_for_booking() (added in
-- 20260818060000) into cancel_booking() itself, so any OTHER
-- still-pending whatsapp queue row tied to this booking (e.g. a
-- booking-confirmed message queued moments earlier that hadn't been
-- claimed/sent yet) is explicitly marked cancelled at the moment of
-- cancellation, rather than relying solely on the claim-time filter in
-- whatsapp_connector_claim_next_batch() to silently skip it forever.
-- REPLACES cancel_booking() -- full body preserved from
-- 20260817120000, one new line added after the existing
-- booking.cancelled event + queue_whatsapp_notification call.
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

  -- Part K: any other still-pending/retrying whatsapp message tied to
  -- this booking (e.g. a booking-confirmed notice queued moments
  -- earlier and not yet claimed) is explicitly cancelled now, rather
  -- than only being silently filtered at claim time.
  perform public.cancel_pending_whatsapp_for_booking(p_booking_id);
end;
$$;

revoke execute on function public.cancel_booking(uuid, text) from public;
revoke execute on function public.cancel_booking(uuid, text) from anon;
grant execute on function public.cancel_booking(uuid, text) to authenticated;

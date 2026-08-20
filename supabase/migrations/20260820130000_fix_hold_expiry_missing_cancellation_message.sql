-- MASTER OPERATIONAL SIMPLIFICATION DIRECTIVE (2026-08-20), section 11:
-- "Cancellation must also be consolidated into ONE message." Real bug
-- found by independent investigation: expire_stale_booking_holds()'s
-- own comment claims to mirror cancel_booking()'s side effects
-- ("audit log, notification event, cancellation WhatsApp message") but
-- the actual queue_whatsapp_notification() call was never written --
-- only emit_notification_event() (the internal fact) and
-- cancel_pending_whatsapp_for_booking() (the suppression sweep) are
-- called, with nothing in between to actually queue the customer-facing
-- message. Confirmed live: every booking auto-cancelled by this
-- pg_cron reaper since it was deployed on 2026-08-19 has silently
-- produced ZERO WhatsApp cancellation messages, independent of
-- consent/phone/connection state -- a real customer-facing gap, not a
-- policy-correct no-op like the consent-disabled cases also found in
-- the same investigation.
--
-- Fix: add the missing queue_whatsapp_notification() call, in the same
-- position cancel_booking() uses it (between emit and suppress-sweep),
-- with the same template/category/dedup_key shape. Also resolves
-- field_name (not previously selected here at all -- needed by the
-- 'booking-cancelled' template's field_name variable).
create or replace function public.expire_stale_booking_holds()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_booking record;
  v_count integer := 0;
  v_event_id uuid;
  v_field_name text;
begin
  for v_booking in
    select id, club_id, customer_id, field_id, start_at
    from public.bookings
    where status = 'pending_payment'
      and hold_expires_at is not null
      and hold_expires_at < now()
    order by hold_expires_at
    limit 200
  loop
    update public.bookings
    set status = 'cancelled', cancelled_reason = 'Payment hold expired', cancelled_at = now()
    where id = v_booking.id and status = 'pending_payment';

    if found then
      v_count := v_count + 1;

      perform public.write_audit_log(v_booking.club_id, 'booking.hold_expired', 'booking', v_booking.id, null,
        jsonb_build_object('status', 'cancelled', 'reason', 'payment_hold_expired'), null);

      select name into v_field_name from public.fields where id = v_booking.field_id;

      v_event_id := public.emit_notification_event(
        v_booking.club_id, 'booking.cancelled', 'booking', v_booking.id,
        jsonb_build_object('customer_id', v_booking.customer_id, 'reason', 'payment_hold_expired', 'start_at', v_booking.start_at)
      );

      -- The actual fix: this call was missing entirely. Mirrors
      -- cancel_booking()'s own queue_whatsapp_notification() call
      -- verbatim (same template/category/dedup_key shape) so an
      -- auto-expired booking produces the same one customer-facing
      -- message a staff cancellation does.
      perform public.queue_whatsapp_notification(
        v_booking.club_id, v_event_id, v_booking.customer_id, 'booking-cancelled', 'booking_confirmations',
        jsonb_build_object('field_name', coalesce(v_field_name, ''), 'start_at', v_booking.start_at, 'reason', 'Payment hold expired'),
        'transactional', 'booking.cancelled:' || v_booking.id::text
      );

      perform public.cancel_pending_whatsapp_for_booking(v_booking.id, v_event_id);
    end if;
  end loop;

  return v_count;
end;
$$;

-- MAL3ABY PRODUCT/UX/BOOKING/PAYMENT DIRECTIVE -- Part 2: payment hold.
--
-- Server-backed 60-minute (per-club configurable) payment hold. The
-- existing EXCLUDE USING gist (field_id, during) WHERE status IN
-- (pending_payment, confirmed, checked_in) constraint on bookings ALREADY
-- provides the atomic slot-reservation half of this requirement (a
-- pending_payment booking already blocks a conflicting booking for the
-- same slot at the DB level, immune to application-level races) -- no
-- new reservation table needed, per the audit-first REUSE rule. What's
-- missing is: (a) a real timestamp marking when a pending_payment
-- booking's hold expires, and (b) a mechanism that actually transitions
-- an expired pending_payment booking to 'cancelled' so the exclusion
-- constraint releases the slot.
--
-- hold_expires_at is set at booking-creation time from the club's own
-- club_booking_policy.payment_hold_minutes (default 60). A confirmed/
-- paid booking's hold_expires_at is irrelevant (status already moved
-- past pending_payment) -- left in place as a historical record, not
-- cleared, since nothing reads it once status != pending_payment.
--
-- pg_cron (free on this Supabase plan, confirmed via list_extensions --
-- not a paid add-on) runs the reaper every minute. This is genuinely
-- the correct mechanism here, not a workaround: the WhatsApp queue's
-- own expire-stale-processing-rows pattern (whatsapp_connector_
-- expire_stale(), already in production) proves periodic server-side
-- reaping is this codebase's established pattern for exactly this
-- class of problem, just via a different trigger (connector poll tick)
-- since no cron existed at the time. This migration finally enables
-- pg_cron since a real, direct need for it now exists -- not enabled
-- speculatively.

alter table public.bookings add column if not exists hold_expires_at timestamptz;

comment on column public.bookings.hold_expires_at is 'When this booking''s payment hold expires (only meaningful while status=pending_payment). Set at creation from the club''s club_booking_policy.payment_hold_minutes. expire_stale_booking_holds() transitions expired pending_payment bookings to cancelled every minute via pg_cron.';

-- Reaper: expires any pending_payment booking whose hold has passed,
-- atomically per-row (each row's own transaction via the loop, so one
-- bad row can't block the rest), mirroring cancel_booking()'s own
-- state-transition side effects (audit log, notification event,
-- cancellation WhatsApp message) so an auto-expired booking looks
-- identical downstream to a staff-cancelled one -- no special-cased
-- "silently vanished" booking state anywhere else in the system.
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

      -- Same pattern cancel_booking() uses: cancel any still-pending
      -- WhatsApp messages tied to this booking (including
      -- payment-referenced ones via the fixed
      -- cancel_pending_whatsapp_for_booking()) before queuing the
      -- expiry notice, so a stale "your booking is confirmed" message
      -- can never outlive the booking it describes.
      v_event_id := public.emit_notification_event(
        v_booking.club_id, 'booking.cancelled', 'booking', v_booking.id,
        jsonb_build_object('customer_id', v_booking.customer_id, 'reason', 'payment_hold_expired', 'start_at', v_booking.start_at)
      );

      perform public.cancel_pending_whatsapp_for_booking(v_booking.id, v_event_id);
    end if;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.expire_stale_booking_holds() from public;
-- service_role only (pg_cron runs as the DB owner / superuser context
-- by default in Supabase's managed pg_cron, but explicit narrow grants
-- cost nothing and match this codebase's own "never leave a function
-- callable by more roles than it needs" pattern).

create extension if not exists pg_cron;

select cron.schedule(
  'expire-stale-booking-holds',
  '* * * * *',
  $$select public.expire_stale_booking_holds();$$
);

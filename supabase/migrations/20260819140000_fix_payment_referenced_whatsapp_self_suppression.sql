-- Fix: cancel_pending_whatsapp_for_booking() only cancelled queue rows
-- whose notification_events row had reference_type = 'booking'. This
-- missed every merged/payment-carrying customer-facing message, whose
-- event is emitted as reference_type = 'payment' (payment.received,
-- which backs both the plain payment-confirmation template AND the
-- booking-confirmed-paid merged template introduced by the duplicate-
-- message fix) -- reference_id there is the payment_id, not the
-- booking_id, so the existing join never matched it.
--
-- Confirmed live: a real booking (1d927dd8-...) created with immediate
-- full payment via create_booking() queued exactly one
-- 'booking.confirmed_paid:<booking_id>' message (correct, Task #3's
-- fix). The booking was then cancelled via the real cancel_booking()
-- RPC. The stale booking-confirmed-paid message was NOT cancelled by
-- cancel_pending_whatsapp_for_booking() and remained 'pending' --
-- confirmed by direct inspection of notification_events for that
-- queue row: reference_type = 'payment', reference_id = the payment's
-- own id. A customer would have received "your booking is confirmed
-- and paid" for a booking that is, in fact, cancelled.
--
-- Fix: also match queue rows whose event is a 'payment' referencing a
-- payment that is allocated to an invoice attached to this exact
-- booking (payments -> payment_allocations -> invoices -> bookings).
-- This is a strict identity chain (payment_allocations.invoice_id =
-- bookings.invoice_id), not a heuristic/text match, so it cannot
-- accidentally suppress a different booking's payment notification
-- even if two bookings shared the same customer or club.
create or replace function public.cancel_pending_whatsapp_for_booking(p_booking_id uuid, p_exclude_event_id uuid default null)
returns integer
language sql
security definer
set search_path to 'public', 'pg_temp'
as $$
  with cancelled as (
    update public.notification_queue nq
    set status = 'cancelled'
    from public.notification_events ne
    where nq.event_id = ne.id
      and nq.channel = 'whatsapp'
      and nq.status in ('pending', 'retrying')
      and (p_exclude_event_id is null or ne.id != p_exclude_event_id)
      and (
        -- Direct: the event is about this booking itself.
        (ne.reference_type = 'booking' and ne.reference_id = p_booking_id)
        or
        -- Indirect: the event is about a payment that was allocated
        -- to the invoice this exact booking is attached to.
        (ne.reference_type = 'payment' and exists (
          select 1
          from public.payment_allocations pa
          join public.bookings b on b.invoice_id = pa.invoice_id
          where pa.payment_id = ne.reference_id
            and b.id = p_booking_id
        ))
      )
    returning nq.id
  )
  select count(*)::integer from cancelled;
$$;

comment on function public.cancel_pending_whatsapp_for_booking(uuid, uuid) is
  'Cancels pending/retrying WhatsApp queue rows for a booking, including merged payment-confirmation messages whose event references the payment (not the booking) directly -- fixed 2026-08-19, see migration comment for the live repro.';

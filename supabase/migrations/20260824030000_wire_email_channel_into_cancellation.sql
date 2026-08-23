-- EMAIL DELIVERY CHANNEL -- wire cancel_booking() (2026-08-24).
--
-- cancel_pending_whatsapp_for_booking() is renamed in effect to be
-- channel-agnostic (drops the hardcoded `nq.channel = 'whatsapp'`
-- filter) -- a cancelled booking must stop BOTH a still-pending
-- WhatsApp send AND a still-pending email send, not just one. The
-- function name is kept as-is (cancel_pending_whatsapp_for_booking)
-- to avoid an unnecessary rename of a function that may already be
-- referenced elsewhere -- confirmed via prosrc search that
-- cancel_booking() is its only caller, so behavior-widening it in
-- place is safe and matches directive rule 2 ("do not duplicate
-- business logic").
create or replace function public.cancel_pending_whatsapp_for_booking(p_booking_id uuid, p_exclude_event_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with cancelled as (
    update public.notification_queue nq
    set status = 'cancelled'
    from public.notification_events ne
    where nq.event_id = ne.id
      and nq.channel in ('whatsapp', 'email')
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
$function$;

create or replace function public.cancel_booking(p_booking_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id uuid;
  v_customer_id uuid;
  v_field_id uuid;
  v_field_name text;
  v_start_at timestamptz;
  v_event_id uuid;
  v_invoice_id uuid;
  v_paid numeric;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a cancellation reason is required';
  end if;

  select club_id, customer_id, field_id, start_at, invoice_id
    into v_club_id, v_customer_id, v_field_id, v_start_at, v_invoice_id
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

  update public.qr_credentials
  set status = 'revoked'
  where type = 'booking' and reference_id = p_booking_id and status = 'active';

  if v_invoice_id is not null then
    perform 1 from public.invoices where id = v_invoice_id for update;

    select coalesce(sum(pa.amount), 0) into v_paid
    from public.payment_allocations pa where pa.invoice_id = v_invoice_id;

    if v_paid = 0 then
      update public.invoices
      set status = 'void', updated_at = now()
      where id = v_invoice_id and status = 'issued';

      if found then
        perform public.write_audit_log(
          v_club_id, 'invoice.voided_on_booking_cancellation', 'invoices', v_invoice_id,
          jsonb_build_object('status', 'issued'), jsonb_build_object('status', 'void'),
          'booking cancelled: ' || p_reason
        );
      end if;
    end if;
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
  perform public.queue_email_notification(
    v_club_id, v_event_id, v_customer_id, 'booking-cancelled', 'booking_confirmations',
    jsonb_build_object('field_name', coalesce(v_field_name, ''), 'start_at', v_start_at, 'reason', p_reason),
    'transactional', 'booking.cancelled:' || p_booking_id::text
  );

  perform public.cancel_pending_whatsapp_for_booking(p_booking_id, v_event_id);
end;
$function$;

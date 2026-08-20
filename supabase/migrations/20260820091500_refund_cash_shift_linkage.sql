-- Phase H (H3): "Cash refund affects: active shift, expected cash,
-- payment ledger." close_cash_shift()'s own variance math already
-- correctly nets out cash refunds within the shift's time window (see
-- its existing v_cash_refunded query, unchanged) -- that part was
-- already correct. What was missing: refunds.cash_shift_id (added in
-- Phase D's schema migration alongside payments.cash_shift_id) was
-- never actually populated by create_refund() -- the column existed
-- but nothing ever wrote to it, making it dead/unlinked exactly like
-- payments.cash_shift_id was before this session's record_payment()
-- fix. This closes that gap: a cash refund against a payment that was
-- itself linked to a shift is now linked to the SAME shift (the
-- payment's shift is the correct one to attribute the refund to, not
-- whichever shift happens to be open when the refund is processed --
-- a refund can legitimately happen in a later shift than the original
-- payment).
create or replace function public.create_refund(p_payment_id uuid, p_amount numeric, p_reason text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_payment record;
  v_refunded_sum numeric;
  v_refund_id uuid;
  v_event_id uuid;
  v_club_name text;
  v_customer_name text;
  v_invoice_number text;
  v_booking_ref text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_amount <= 0 then
    raise exception 'refund amount must be positive';
  end if;

  if p_reason is null or trim(p_reason) = '' then
    raise exception 'a reason is required for a refund';
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if v_payment.id is null then
    raise exception 'payment not found';
  end if;

  if not (v_payment.club_id in (select public.user_club_ids()) and public.has_permission('payment.refund', v_payment.club_id)) then
    raise exception 'not authorized';
  end if;

  if not public.club_write_allowed(v_payment.club_id, 'settle_existing') then
    raise exception 'club subscription does not allow settling existing balances';
  end if;

  select coalesce(sum(amount), 0) into v_refunded_sum
  from public.refunds
  where payment_id = p_payment_id and status = 'completed';

  if p_amount > (v_payment.amount - v_refunded_sum) then
    raise exception 'refund amount exceeds refundable balance (refundable: %)', (v_payment.amount - v_refunded_sum);
  end if;

  -- H3: attribute the refund to the same shift the original payment
  -- was collected under (null if the payment predates shift linkage or
  -- was collected by a non-custody employee) -- never the shift that
  -- happens to be open now, which could be a different day/employee
  -- entirely.
  insert into public.refunds (payment_id, amount, reason, status, refunded_by, cash_shift_id)
  values (p_payment_id, p_amount, p_reason, 'completed', auth.uid(), v_payment.cash_shift_id)
  returning id into v_refund_id;

  perform public.write_audit_log(
    v_payment.club_id, 'payment.refund', 'refund', v_refund_id, null,
    jsonb_build_object('payment_id', p_payment_id, 'amount', p_amount, 'cash_shift_id', v_payment.cash_shift_id),
    p_reason
  );

  select name into v_club_name from public.clubs where id = v_payment.club_id;
  select full_name into v_customer_name from public.customers where id = v_payment.customer_id;
  select i.invoice_number, 'MB-' || upper(substring(b.id::text, 1, 8))
    into v_invoice_number, v_booking_ref
    from public.payment_allocations pa
    join public.invoices i on i.id = pa.invoice_id
    left join public.bookings b on b.invoice_id = i.id
    where pa.payment_id = p_payment_id
    limit 1;

  v_event_id := public.emit_notification_event(
    v_payment.club_id, 'payment.refunded', 'refund', v_refund_id,
    jsonb_build_object('payment_id', p_payment_id, 'amount', p_amount, 'customer_id', v_payment.customer_id, 'reason', p_reason)
  );

  perform public.queue_whatsapp_notification(
    v_payment.club_id, v_event_id, v_payment.customer_id, 'payment-refunded', 'payment_confirmations',
    jsonb_build_object(
      'amount', p_amount, 'reason', p_reason, 'club_name', v_club_name, 'customer_name', v_customer_name,
      'invoice_number', v_invoice_number, 'booking_ref', v_booking_ref
    ),
    'transactional', 'payment.refunded:' || v_refund_id::text
  );

  return v_refund_id;
end;
$function$;

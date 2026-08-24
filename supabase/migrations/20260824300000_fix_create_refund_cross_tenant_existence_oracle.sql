-- SECURITY FIX (LOW/INFORMATIONAL, same class as
-- 20260824290000_fix_record_payment_cross_tenant_existence_oracle.sql,
-- live-verified via this audit's systemic RPC sweep -- project
-- gxkrtlvpjwxhcqdisyob): create_refund() looked up the target payment
-- by a bare, unscoped `select * into v_payment from public.payments
-- where id = p_payment_id` and raised the DISTINCT exception 'payment
-- not found' BEFORE checking `has_permission('payment.refund',
-- v_payment.club_id)` (which raises the DIFFERENT exception 'not
-- authorized') -- letting any authenticated staff member of any club
-- distinguish "this payment id exists" from "it doesn't", for any
-- payment UUID system-wide. Same fix shape: collapse the lookup and
-- authorization check into one club/permission-scoped WHERE, so both
-- failure paths raise the identical message.
--
-- No other logic changes -- every downstream check (reason required,
-- club_write_allowed, refundable-balance cap, cash-shift attribution,
-- audit log, notification) is copied verbatim from the current live
-- definition.

create or replace function public.create_refund(p_payment_id uuid, p_amount numeric, p_reason text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
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

  -- SECURITY FIX: lookup and authorization collapsed into one step so
  -- neither branch reveals whether a non-authorized payment id exists.
  select * into v_payment
  from public.payments
  where id = p_payment_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('payment.refund', club_id)
  for update;

  if v_payment.id is null then
    raise exception 'payment not found or you do not have permission to refund it';
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
$$;

-- Signature unchanged -- in-place replace, grants untouched.

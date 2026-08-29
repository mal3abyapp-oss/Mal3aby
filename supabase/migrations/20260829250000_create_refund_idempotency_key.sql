-- SAAS ACCEPTANCE REVIEW -- idempotency/concurrency audit finding
-- (2026-08-29), P2: create_refund() (the manual/staff-facing refund
-- RPC, called from BillingPage.tsx's general refund flow) accepted no
-- idempotency key at all, unlike its sibling
-- create_gateway_refund_service() which already has full replay
-- protection via a real unique index (refunds_payment_idempotency_key_unique
-- on (payment_id, idempotency_key), confirmed already present). A
-- double-click or network retry of the same refund submission could
-- insert two separate refunds rows for the same logical action, each
-- independently valid against the refundable-balance check (since the
-- check runs before either insert commits), double-posting a real
-- refund.
--
-- Fix: add the same optional p_idempotency_key parameter and
-- check-then-insert-with-replay pattern create_gateway_refund_service
-- already uses -- a repeated call with the same key returns the
-- original refund's id instead of creating a second row. Optional
-- (defaults to null) so this is fully backward compatible with any
-- caller that doesn't pass one yet.
create or replace function public.create_refund(p_payment_id uuid, p_amount numeric, p_reason text, p_idempotency_key uuid DEFAULT NULL::uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_payment record;
  v_refunded_sum numeric;
  v_refund_id uuid;
  v_existing_refund_id uuid;
  v_event_id uuid;
  v_club_name text;
  v_customer_name text;
  v_invoice_number text;
  v_booking_ref text;
  v_membership_id_to_cancel uuid;
  v_membership_status text;
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

  if p_idempotency_key is not null then
    select id into v_existing_refund_id from public.refunds
    where payment_id = p_payment_id and idempotency_key = p_idempotency_key;

    if v_existing_refund_id is not null then
      return v_existing_refund_id;
    end if;
  end if;

  select coalesce(sum(amount), 0) into v_refunded_sum
  from public.refunds
  where payment_id = p_payment_id and status = 'completed';

  if p_amount > (v_payment.amount - v_refunded_sum) then
    raise exception 'refund amount exceeds refundable balance (refundable: %)', (v_payment.amount - v_refunded_sum);
  end if;

  insert into public.refunds (payment_id, amount, reason, status, refunded_by, cash_shift_id, idempotency_key)
  values (p_payment_id, p_amount, p_reason, 'completed', auth.uid(), v_payment.cash_shift_id, p_idempotency_key)
  returning id into v_refund_id;

  if (v_refunded_sum + p_amount) >= v_payment.amount then
    select s.id, s.status into v_membership_id_to_cancel, v_membership_status
    from public.payment_allocations pa
    join public.club_membership_subscriptions s on s.invoice_id = pa.invoice_id
    where pa.payment_id = p_payment_id
    limit 1;

    if v_membership_id_to_cancel is not null and v_membership_status != 'cancelled' then
      perform set_config('app.allow_club_membership_status_transition', 'true', true);
      update public.club_membership_subscriptions
      set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
          cancel_reason = 'auto-cancelled: full refund of payment ' || p_payment_id::text || ' -- ' || p_reason
      where id = v_membership_id_to_cancel;

      perform public.write_audit_log(
        v_payment.club_id, 'club_membership.cancelled', 'club_membership_subscription', v_membership_id_to_cancel,
        jsonb_build_object('previous_status', v_membership_status),
        jsonb_build_object('cause', 'full_refund', 'refund_id', v_refund_id),
        p_reason
      );
    end if;
  end if;

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

-- Task #90 (full financial regression): real bug found via a live
-- chained test -- create a real booking (pending_payment) -> split it
-- across two record_payment() calls (task #84's UI) totalling the
-- full invoice amount -> get_invoice_payment_summary() correctly
-- reported paid/outstanding=0, but bookings.status stayed
-- 'pending_payment' forever. Confirmed by grepping every
-- `update bookings set status = 'confirmed'` call site in this
-- schema's history: EVERY one of them lives inside
-- _create_booking_internal()'s own inline-payment-at-creation path
-- (the p_record_payment flag) -- record_payment(), the RPC used for
-- every payment recorded AFTER booking creation (BillingPage's manual
-- payment form, task #83's manual-claim verification, task #84's split
-- payments), has never once updated bookings.status. This directly
-- violates the Master Payment Directive's own single-source-of-truth
-- principle (task #81: "unpaid -> paid transitions must apply
-- consistently everywhere") -- a booking paid off after creation (the
-- overwhelmingly common real-world case: pay at creation vs. pay
-- later/in installments) silently never reaches 'confirmed', which
-- means it never becomes visible as confirmed anywhere that filters or
-- displays by booking status, and (per ADR-021) it keeps holding its
-- exclusion-constraint slot under a status that looks unresolved
-- forever.
--
-- Fix: record_payment() REPLACED (full body preserved, one addition)
-- to check, after applying the payment, whether this invoice has any
-- linked booking still in pending_payment, and if the invoice is now
-- fully paid (v_new_outstanding <= 0), transition that booking to
-- confirmed -- mirroring the exact same "if p_record_payment made it
-- fully paid, confirm the booking" logic _create_booking_internal
-- already has, just reached from the later-payment path instead of
-- the at-creation path. A booking that's still only PARTIALLY paid
-- after this call correctly stays pending_payment (unchanged
-- behavior, matches the existing partially_paid semantics) --
-- confirmation only fires on reaching full payment, never on a
-- partial one.
create or replace function public.record_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_method text,
  p_reference text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice record;
  v_payment_id uuid;
  v_pending_subscription_id uuid;
  v_outstanding numeric;
  v_event_id uuid;
  v_new_outstanding numeric;
  v_pending_booking_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  if p_method not in ('cash', 'card', 'bank_transfer', 'wallet', 'other') then
    raise exception 'invalid method';
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id;
  if v_invoice is null then
    raise exception 'invoice not found';
  end if;

  if not (v_invoice.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', v_invoice.club_id)) then
    raise exception 'not authorized';
  end if;

  if not public.club_write_allowed(v_invoice.club_id, 'settle_existing') then
    raise exception 'club subscription does not allow settling existing balances';
  end if;

  if v_invoice.status != 'issued' then
    raise exception 'can only record payment against an issued invoice';
  end if;

  select v_invoice.total
    - coalesce((select sum(pa.amount) from public.payment_allocations pa where pa.invoice_id = v_invoice.id), 0)
    + coalesce((select sum(r.amount) from public.payment_allocations pa
                join public.refunds r on r.payment_id = pa.payment_id and r.status = 'completed'
                where pa.invoice_id = v_invoice.id), 0)
  into v_outstanding;

  if p_amount > v_outstanding then
    raise exception 'payment amount (%) exceeds the invoice''s outstanding balance (%)', p_amount, v_outstanding;
  end if;

  insert into public.payments (club_id, branch_id, customer_id, method, amount, reference, received_by)
  values (v_invoice.club_id, v_invoice.branch_id, v_invoice.customer_id, p_method, p_amount, p_reference, auth.uid())
  returning id into v_payment_id;

  perform public.write_audit_log(
    v_invoice.club_id, 'payment.record', 'payment', v_payment_id, null,
    jsonb_build_object('amount', p_amount, 'method', p_method, 'invoice_id', p_invoice_id),
    null
  );

  insert into public.payment_allocations (payment_id, invoice_id, amount)
  values (v_payment_id, p_invoice_id, p_amount);

  select id into v_pending_subscription_id from public.subscriptions
  where invoice_id = p_invoice_id and status = 'pending'
  limit 1;

  if v_pending_subscription_id is not null then
    perform public._activate_subscription_if_due_internal(v_pending_subscription_id);
  end if;

  v_new_outstanding := greatest(v_outstanding - p_amount, 0);

  -- Real gap fixed: a booking linked to this invoice, still awaiting
  -- payment, now reaching full payment (v_new_outstanding <= 0) via a
  -- payment recorded AFTER booking creation must transition to
  -- 'confirmed' -- the same rule _create_booking_internal already
  -- applies for payment collected AT creation, now applied
  -- consistently for payment collected later too (Master Payment
  -- Directive task #81's single-source-of-truth requirement).
  -- Deliberately still pending_payment if v_new_outstanding > 0 --
  -- confirmation only fires on reaching full payment, matching
  -- existing partially_paid semantics.
  if v_new_outstanding <= 0 then
    select id into v_pending_booking_id from public.bookings
    where invoice_id = p_invoice_id and status = 'pending_payment'
    limit 1;

    if v_pending_booking_id is not null then
      update public.bookings set status = 'confirmed' where id = v_pending_booking_id;

      perform public.write_audit_log(
        v_invoice.club_id, 'booking.auto_confirmed_on_full_payment', 'bookings', v_pending_booking_id, null,
        jsonb_build_object('invoice_id', p_invoice_id, 'triggering_payment_id', v_payment_id),
        null
      );
    end if;
  end if;

  -- Section 10: notification only AFTER the DB state (payment +
  -- allocation, any subscription activation, any booking confirmation)
  -- is durably committed as part of this same transaction -- never before.
  v_event_id := public.emit_notification_event(
    v_invoice.club_id, 'payment.received', 'payment', v_payment_id,
    jsonb_build_object('amount', p_amount, 'method', p_method, 'customer_id', v_invoice.customer_id, 'invoice_id', p_invoice_id, 'remaining_outstanding', v_new_outstanding)
  );

  perform public.queue_whatsapp_notification(
    v_invoice.club_id, v_event_id, v_invoice.customer_id, 'payment-received', 'payment_confirmations',
    jsonb_build_object(
      'amount', p_amount, 'invoice_number', v_invoice.invoice_number,
      'payment_status', case when v_new_outstanding <= 0 then 'paid' else 'partially_paid' end,
      'remaining_outstanding', v_new_outstanding
    ),
    'transactional', 'payment.received:' || v_payment_id::text
  );

  return v_payment_id;
end;
$$;

revoke execute on function public.record_payment(uuid, numeric, text, text) from public;
revoke execute on function public.record_payment(uuid, numeric, text, text) from anon;
grant execute on function public.record_payment(uuid, numeric, text, text) to authenticated;

comment on function public.record_payment(uuid, numeric, text, text) is
  'Task #90 fix: now also confirms a linked pending_payment booking when the payment being recorded brings the invoice to fully paid (previously only _create_booking_internal''s inline-payment-at-creation path did this -- a booking paid off later, e.g. via split payments or a manual claim, never transitioned to confirmed). Still no-ops for a booking that stays partially paid.';

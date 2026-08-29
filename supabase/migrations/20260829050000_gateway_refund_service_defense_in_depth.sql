-- ZERO-TRUST ANTI-FRAUD HARDENING -- Phase 2 (2026-08-29)
--
-- CF-3 from PAYMENT_GATEWAY_SECURITY_ATTACK_MATRIX_EXTENSION.md:
-- create_gateway_refund_service() (and its siblings
-- record_gateway_payment_service/mark_gateway_transaction_failed_service)
-- are service_role-only RPCs with ZERO internal actor/permission check --
-- the entire cross-club-refund defense rests on the calling Edge
-- Function's own has_permission() re-check (verified real and correct
-- in all 5 *-create-refund functions, using the caller's own JWT-scoped
-- client, not the service-role client), never independently confirmed.
--
-- LIVE-CONFIRMED this pass: neither `authenticated` nor `anon` can
-- execute create_gateway_refund_service directly (has_function_privilege
-- returns false for both) -- so this is not a directly client-
-- exploitable P0/P1 (a browser session or forged RPC call cannot reach
-- it at all; only the Edge Function, holding the service-role key on
-- the server, can call it). This downgrades it from CF-3's original
-- framing to a genuine but lower-severity defense-in-depth gap: exactly
-- one layer of defense where a security-sensitive financial mutation
-- should have two, per the directive's own Section 22 ("high-risk
-- refunds... use approval/second-authority only where commercially
-- justified" -- this isn't a business-process dual-approval, it's the
-- narrower, uncontroversial case of the RPC re-verifying what its only
-- legitimate caller already claims to have verified).
--
-- FIX: add an internal has_permission_as() check, gated on p_actor_id
-- IS NOT NULL. All 5 real user-initiated refund Edge Functions
-- (stripe/paymob/kashier/fawry/paypal-create-refund) already pass
-- p_actor_id: user.id (confirmed by grep, all 5 identical). The one
-- exception -- stripe-gateway-webhook's reconciliation call, passing
-- p_actor_id: null -- represents a genuinely different authorization
-- model: a provider-originated refund event (e.g. initiated from the
-- Stripe dashboard, not from Mal3aby), already authorized by the
-- webhook's own HMAC signature verification, where there IS no human
-- actor to permission-check. Gating the new check on `p_actor_id is not
-- null` preserves that legitimate system-call path unchanged while
-- closing the gap for every real user-initiated call.
--
-- Return shape unchanged (returns uuid), only internal logic added --
-- CREATE OR REPLACE is safe here, no DROP FUNCTION needed.

create or replace function public.create_gateway_refund_service(
  p_payment_id uuid, p_amount numeric, p_reason text, p_provider_refund_ref text,
  p_transaction_id uuid, p_actor_id uuid default null, p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_payment record;
  v_txn public.payment_gateway_transactions;
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
  v_idem_key uuid;
begin
  if p_amount <= 0 then
    raise exception 'refund amount must be positive';
  end if;

  if p_reason is null or trim(p_reason) = '' then
    raise exception 'a reason is required for a refund';
  end if;

  -- Lock the payment row -- same discipline create_refund() itself
  -- uses, now without a caller-permission predicate (this RPC's
  -- caller-authorization already happened in the Edge Function, using
  -- the caller's own JWT against the SAME permission create_refund()
  -- requires -- see stripe-create-refund's own comment).
  select * into v_payment from public.payments where id = p_payment_id for update;

  if v_payment.id is null then
    raise exception 'payment not found';
  end if;

  -- DEFENSE-IN-DEPTH (added this pass, CF-3): a real user-initiated call
  -- always carries p_actor_id -- re-verify that actor genuinely holds
  -- payment.refund for THIS payment's club, independent of whatever the
  -- calling Edge Function already checked. A null actor (the
  -- stripe-gateway-webhook reconciliation path, already authorized by
  -- HMAC signature verification) is a different, legitimate
  -- authorization model and is intentionally not subject to this check.
  if p_actor_id is not null and not public.has_permission_as(p_actor_id, 'payment.refund', v_payment.club_id) then
    raise exception 'not authorized';
  end if;

  -- SAME-PROVIDER INVARIANT: the gateway transaction supplied must be
  -- the one that actually produced this payment (payment_gateway_transactions.payment_id
  -- = p_payment_id) -- this closes "refund a Stripe payment through a
  -- different gateway/connection" by construction: there is no way to
  -- satisfy this check with a transaction row that isn't the original
  -- payment's own linked transaction.
  select * into v_txn from public.payment_gateway_transactions where id = p_transaction_id;

  if v_txn.id is null then
    raise exception 'gateway transaction not found';
  end if;

  if v_txn.payment_id is distinct from p_payment_id then
    raise exception 'gateway transaction does not correspond to this payment -- refusing cross-provider refund';
  end if;

  if v_txn.status <> 'succeeded' then
    raise exception 'gateway transaction is not in a succeeded state -- refusing to refund';
  end if;

  -- Idempotency: a retried call with the same idempotency key (e.g. a
  -- webhook-driven confirmation retried after a network timeout, or a
  -- refund.updated webhook arriving after the synchronous API call
  -- already posted the same refund) returns the existing row instead
  -- of double-posting.
  v_idem_key := coalesce(p_idempotency_key, p_transaction_id);

  select id into v_existing_refund_id from public.refunds
  where payment_id = p_payment_id and idempotency_key = v_idem_key;

  if v_existing_refund_id is not null then
    return v_existing_refund_id;
  end if;

  select coalesce(sum(amount), 0) into v_refunded_sum
  from public.refunds
  where payment_id = p_payment_id and status = 'completed';

  if p_amount > (v_payment.amount - v_refunded_sum) then
    raise exception 'refund amount exceeds refundable balance (refundable: %)', (v_payment.amount - v_refunded_sum);
  end if;

  insert into public.refunds (payment_id, amount, reason, status, refunded_by, cash_shift_id, idempotency_key, provider_refund_ref)
  values (p_payment_id, p_amount, p_reason, 'completed', p_actor_id, v_payment.cash_shift_id, v_idem_key, p_provider_refund_ref)
  returning id into v_refund_id;

  -- Club Membership integration: identical rule to create_refund() --
  -- a FULL refund (this refund + all prior completed refunds ==
  -- the full payment amount) against a payment allocated to a
  -- club_membership_subscriptions invoice cancels that membership
  -- period.
  if (v_refunded_sum + p_amount) >= v_payment.amount then
    select s.id, s.status into v_membership_id_to_cancel, v_membership_status
    from public.payment_allocations pa
    join public.club_membership_subscriptions s on s.invoice_id = pa.invoice_id
    where pa.payment_id = p_payment_id
    limit 1;

    if v_membership_id_to_cancel is not null and v_membership_status != 'cancelled' then
      perform set_config('app.allow_club_membership_status_transition', 'true', true);
      update public.club_membership_subscriptions
      set status = 'cancelled', cancelled_at = now(), cancelled_by = p_actor_id,
          cancel_reason = 'auto-cancelled: full gateway refund of payment ' || p_payment_id::text || ' -- ' || p_reason
      where id = v_membership_id_to_cancel;

      perform public.write_audit_log(
        v_payment.club_id, 'club_membership.cancelled', 'club_membership_subscription', v_membership_id_to_cancel,
        jsonb_build_object('previous_status', v_membership_status),
        jsonb_build_object('cause', 'full_gateway_refund', 'refund_id', v_refund_id),
        p_reason
      );
    end if;
  end if;

  perform public.write_audit_log(
    v_payment.club_id, 'payment.gateway_refund', 'refund', v_refund_id, null,
    jsonb_build_object(
      'payment_id', p_payment_id, 'amount', p_amount, 'cash_shift_id', v_payment.cash_shift_id,
      'gateway', v_txn.gateway, 'transaction_id', p_transaction_id, 'provider_refund_ref', p_provider_refund_ref
    ),
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

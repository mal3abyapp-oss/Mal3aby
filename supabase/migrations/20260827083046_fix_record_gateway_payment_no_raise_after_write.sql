-- =====================================================================
-- Fix: record_gateway_payment_service must not RAISE EXCEPTION after
-- it has already written a rejection outcome to
-- payment_gateway_transactions/audit_logs.
--
-- BUG FOUND DURING LIVE VERIFICATION: a PL/pgSQL function body executes
-- as a single implicit transaction (or sub-transaction of its caller).
-- An unhandled `raise exception` unwinds and rolls back EVERY statement
-- executed earlier in that same function call -- including the
-- `update ... set status = 'failed', failure_reason = ...` and the
-- `write_audit_log(...)` calls that were meant to durably record WHY
-- the payment was rejected. Live-tested: after an amount-mismatch
-- call raised, the transaction row was found still 'pending' with
-- failure_reason still null -- the rejection state was silently lost.
-- This does NOT create a double-post risk (the payment insert never
-- ran either), but it defeats the entire point of failing closed with
-- a recorded reason: the webhook Edge Function has nothing durable to
-- inspect, and a transaction that should read 'failed' still reads
-- 'pending' forever (or until some other call touches it).
--
-- FIX: every REJECTION path (amount mismatch, currency mismatch,
-- invoice-not-found, invoice-not-issued, exceeds-outstanding) now
-- commits its status/audit write and then RETURNS NULL instead of
-- raising. `raise exception` is reserved for genuine caller errors
-- that happen BEFORE any write in this function (transaction not
-- found at all, or an already non-pending transaction where we
-- deliberately must not touch state) -- those are safe to raise
-- because nothing has been written yet to lose.
--
-- Callers (the webhook Edge Function) must treat a NULL return as "the
-- transaction was durably marked failed -- read
-- payment_gateway_transactions.failure_reason for why", not as an
-- unexpected error.
-- =====================================================================
create or replace function public.record_gateway_payment_service(
  p_transaction_id uuid,
  p_confirmed_amount numeric,
  p_confirmed_currency text,
  p_provider_session_ref text,
  p_provider_raw_status text
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_txn public.payment_gateway_transactions;
  v_invoice record;
  v_outstanding numeric;
  v_new_outstanding numeric;
  v_payment_id uuid;
  v_existing_payment_id uuid;
  v_idem_key uuid;
begin
  -- Lock the staged transaction row first -- this is both our
  -- idempotency boundary (a duplicate webhook delivery blocks on this
  -- lock until the first call's transaction commits, then sees
  -- status <> 'pending' and is rejected below) and our concurrency
  -- boundary against a second, different transaction racing to pay the
  -- same invoice. Nothing has been written yet at this point, so a
  -- raise here is safe -- there is no state to lose.
  select * into v_txn from public.payment_gateway_transactions where id = p_transaction_id for update;

  if v_txn.id is null then
    raise exception 'gateway transaction not found';
  end if;

  -- Idempotency / replay defense: a webhook retried after the first
  -- delivery already posted the payment (or after the transaction was
  -- already marked failed/cancelled by a prior delivery) must not
  -- reprocess. Still nothing written yet in THIS call, so raising here
  -- (for the genuinely-unexpected "not pending and not a known
  -- succeeded-replay" case) is also safe.
  if v_txn.status <> 'pending' then
    if v_txn.status = 'succeeded' and v_txn.payment_id is not null then
      return v_txn.payment_id;
    end if;
    raise exception 'gateway transaction is not pending (status: %) -- refusing to reprocess', v_txn.status;
  end if;

  -- CRITICAL: cross-check the PROVIDER-CONFIRMED amount/currency
  -- against what we staged at checkout-start time. This function's
  -- caller (the webhook Edge Function) is expected to have already
  -- independently fetched/confirmed these values from the provider's
  -- own API after verifying the webhook signature -- but even so, we
  -- never trust a mismatch silently. Any mismatch fails closed: no
  -- payment is posted, ever. From here on, a rejection COMMITS its
  -- write and returns null -- it does not raise, so the write is never
  -- rolled back (see migration header for the bug this fixes).
  if p_confirmed_amount is distinct from v_txn.amount then
    update public.payment_gateway_transactions
    set status = 'failed',
        failure_reason = format('amount mismatch: staged=%s confirmed=%s', v_txn.amount, p_confirmed_amount),
        provider_session_ref = coalesce(p_provider_session_ref, provider_session_ref),
        provider_raw_status = p_provider_raw_status,
        updated_at = now()
    where id = p_transaction_id;

    perform public.write_audit_log(
      v_txn.club_id, 'payment.gateway_rejected', 'payment_gateway_transaction', p_transaction_id, null,
      jsonb_build_object('reason', 'amount_mismatch', 'staged_amount', v_txn.amount, 'confirmed_amount', p_confirmed_amount),
      null
    );

    return null;
  end if;

  if p_confirmed_currency is distinct from v_txn.currency then
    update public.payment_gateway_transactions
    set status = 'failed',
        failure_reason = format('currency mismatch: staged=%s confirmed=%s', v_txn.currency, p_confirmed_currency),
        provider_session_ref = coalesce(p_provider_session_ref, provider_session_ref),
        provider_raw_status = p_provider_raw_status,
        updated_at = now()
    where id = p_transaction_id;

    perform public.write_audit_log(
      v_txn.club_id, 'payment.gateway_rejected', 'payment_gateway_transaction', p_transaction_id, null,
      jsonb_build_object('reason', 'currency_mismatch', 'staged_currency', v_txn.currency, 'confirmed_currency', p_confirmed_currency),
      null
    );

    return null;
  end if;

  -- Re-validate the invoice is still issued and the amount still fits
  -- within outstanding -- closes the race where the invoice was paid
  -- through a DIFFERENT channel (cash, another gateway, staff override)
  -- between checkout-start and this webhook's arrival. Lock the
  -- invoice row too, same discipline record_payment() itself uses.
  perform 1 from public.invoices where id = v_txn.invoice_id for update;

  select * into v_invoice from public.invoices where id = v_txn.invoice_id;

  if v_invoice.id is null then
    update public.payment_gateway_transactions
    set status = 'failed', failure_reason = 'invoice no longer exists', provider_raw_status = p_provider_raw_status, updated_at = now()
    where id = p_transaction_id;

    perform public.write_audit_log(
      v_txn.club_id, 'payment.gateway_rejected', 'payment_gateway_transaction', p_transaction_id, null,
      jsonb_build_object('reason', 'invoice_not_found'),
      null
    );

    return null;
  end if;

  if v_invoice.status <> 'issued' then
    update public.payment_gateway_transactions
    set status = 'failed',
        failure_reason = format('invoice status is %s, not issued -- likely already settled via another channel', v_invoice.status),
        provider_session_ref = coalesce(p_provider_session_ref, provider_session_ref),
        provider_raw_status = p_provider_raw_status,
        updated_at = now()
    where id = p_transaction_id;

    perform public.write_audit_log(
      v_txn.club_id, 'payment.gateway_rejected', 'payment_gateway_transaction', p_transaction_id, null,
      jsonb_build_object('reason', 'invoice_not_issued', 'invoice_status', v_invoice.status),
      null
    );

    return null;
  end if;

  select outstanding into v_outstanding from public.get_invoice_payment_summary(array[v_invoice.id]);

  if p_confirmed_amount > v_outstanding then
    update public.payment_gateway_transactions
    set status = 'failed',
        failure_reason = format('confirmed amount (%s) exceeds current outstanding balance (%s) -- invoice was likely partially settled elsewhere', p_confirmed_amount, v_outstanding),
        provider_session_ref = coalesce(p_provider_session_ref, provider_session_ref),
        provider_raw_status = p_provider_raw_status,
        updated_at = now()
    where id = p_transaction_id;

    perform public.write_audit_log(
      v_txn.club_id, 'payment.gateway_rejected', 'payment_gateway_transaction', p_transaction_id, null,
      jsonb_build_object('reason', 'exceeds_outstanding', 'confirmed_amount', p_confirmed_amount, 'outstanding', v_outstanding),
      null
    );

    return null;
  end if;

  -- Idempotent insert target: use the transaction's own idempotency_key
  -- if it was set at checkout-start time, otherwise fall back to the
  -- transaction id itself so THIS insert is idempotent even without an
  -- explicit key (belt-and-braces alongside the pending-status guard
  -- above, which is the primary replay defense).
  v_idem_key := coalesce(v_txn.idempotency_key, v_txn.id);

  select id into v_existing_payment_id from public.payments
  where club_id = v_txn.club_id and idempotency_key = v_idem_key;

  if v_existing_payment_id is not null then
    -- Should not normally happen given the pending-status guard above,
    -- but if it does (e.g. idempotency_key reused across transactions),
    -- link and return rather than violating the unique constraint or
    -- double-posting.
    update public.payment_gateway_transactions
    set status = 'succeeded', payment_id = v_existing_payment_id,
        provider_session_ref = coalesce(p_provider_session_ref, provider_session_ref),
        provider_raw_status = p_provider_raw_status,
        updated_at = now()
    where id = p_transaction_id;
    return v_existing_payment_id;
  end if;

  insert into public.payments (
    club_id, branch_id, customer_id, method, amount, reference, received_by, idempotency_key
  ) values (
    v_txn.club_id, v_invoice.branch_id, v_invoice.customer_id, 'card', p_confirmed_amount,
    coalesce(p_provider_session_ref, v_txn.gateway || ':' || v_txn.id::text),
    null, v_idem_key
  )
  returning id into v_payment_id;

  insert into public.payment_allocations (payment_id, invoice_id, amount)
  values (v_payment_id, v_invoice.id, p_confirmed_amount);

  update public.payment_gateway_transactions
  set status = 'succeeded',
      payment_id = v_payment_id,
      provider_session_ref = coalesce(p_provider_session_ref, provider_session_ref),
      provider_raw_status = p_provider_raw_status,
      updated_at = now()
  where id = p_transaction_id;

  perform public.write_audit_log(
    v_txn.club_id, 'payment.gateway_confirmed', 'payment', v_payment_id, null,
    jsonb_build_object(
      'amount', p_confirmed_amount, 'currency', p_confirmed_currency, 'gateway', v_txn.gateway,
      'invoice_id', v_invoice.id, 'transaction_id', p_transaction_id,
      'provider_session_ref', p_provider_session_ref, 'provider_raw_status', p_provider_raw_status
    ),
    null
  );

  v_new_outstanding := greatest(v_outstanding - p_confirmed_amount, 0);

  perform public._apply_gateway_payment_side_effects_internal(v_payment_id, v_invoice.id, p_confirmed_amount, v_new_outstanding);

  return v_payment_id;
end;
$function$;

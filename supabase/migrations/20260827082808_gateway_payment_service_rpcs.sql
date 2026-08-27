-- =====================================================================
-- Phase 2 (Multi-Gateway Online Payments) -- webhook-safe payment
-- posting RPCs.
--
-- CONTEXT / WHY THIS MIGRATION EXISTS
-- --------------------------------------------------------------------
-- The canonical `record_payment(...)` RPC is shaped for an authenticated
-- STAFF session: it requires auth.uid() is not null, checks
-- has_permission('payment.create', club_id) against the CALLER's own
-- club membership, and carries cash-shift/custody and official
-- government-receipt logic that only ever applies to in-person cash
-- collection. A payment-gateway webhook (Stripe today, others later)
-- has NO Supabase Auth session at all -- it authenticates the CALLER
-- (the payment provider) via HMAC/RSA signature verification over the
-- raw request body, not a JWT. record_payment() can therefore never be
-- called directly from a webhook: `auth.uid() is null` would always
-- raise, and even if it didn't, none of its cash/receipt logic applies
-- to a card payment collected by a third-party processor.
--
-- This migration adds two new, narrowly-scoped SECURITY DEFINER RPCs,
-- granted ONLY to service_role (mirroring claim_portal_invite_service's
-- own house pattern: this project's precedent for "trusted server
-- context, no end-user session, explicit actor parameter instead of
-- auth.uid()"):
--
--   1. record_gateway_payment_service(...) -- posts a real public.payments
--      row from a PROVIDER-CONFIRMED (not client/webhook-body-trusted)
--      amount/currency, after independently re-validating the staged
--      payment_gateway_transactions row and the invoice's current
--      outstanding balance. Idempotent under webhook retry. Fails
--      closed (marks the transaction 'failed', never posts) on any
--      amount/currency mismatch or invoice-state race.
--
--   2. mark_gateway_transaction_failed_service(...) -- records a
--      failed/cancelled/rejected transaction outcome WITHOUT ever
--      touching public.payments/public.payment_allocations.
--
-- Both reuse the SAME internal activation helpers record_payment()
-- itself calls (_activate_subscription_if_due_internal,
-- _activate_club_membership_if_due_internal, _mint_invoice_token_internal)
-- -- this project's own established convention for shared post-payment
-- logic (grep confirms these _internal-suffixed helpers are already
-- factored out and re-used by record_payment). We deliberately do NOT
-- refactor record_payment()'s own body to extract a shared "post-payment
-- side effects" helper in this migration: record_payment is a
-- production-critical, heavily-iterated function (cash custody,
-- official government receipts, academy vs. venue notification
-- branching) and gateway payments never touch cash-shift/government-
-- receipt logic in the first place (those are cash/in-person-only
-- concerns per the government-collection-compliance migrations). A new,
-- gateway-specific side-effect helper that reuses the SAME
-- already-shared _internal activation primitives gets us real code
-- reuse where it matters (subscription/membership activation, booking
-- auto-confirm, notification emission) without adding gateway-specific
-- branching risk into record_payment's already-dense body.
--
-- NOTE ON STATUS VALUES: payment_gateway_transactions_status_check
-- already constrains status to ('pending','succeeded','failed',
-- 'cancelled') -- there is no 'completed' or 'amount_mismatch' value.
-- We use 'succeeded' for a posted payment and 'failed' (with
-- failure_reason text explaining WHY -- amount mismatch, currency
-- mismatch, invoice race, etc.) for every rejection path. This keeps
-- the migration additive/reversible instead of widening a CHECK
-- constraint that other code may already depend on.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Internal helper: shared post-payment side effects for a GATEWAY
-- payment (subscription/membership activation, booking auto-confirm,
-- notification emission). Mirrors the equivalent tail of record_payment()
-- but has no cash-shift/official-receipt concerns, and takes an
-- explicit actor (nullable -- there is no staff actor for a webhook-
-- posted payment) instead of relying on auth.uid().
-- ---------------------------------------------------------------------
create or replace function public._apply_gateway_payment_side_effects_internal(
  p_payment_id uuid,
  p_invoice_id uuid,
  p_amount numeric,
  p_new_outstanding numeric
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_invoice record;
  v_pending_subscription_id uuid;
  v_pending_membership_id uuid;
  v_pending_booking_id uuid;
  v_club_name text;
  v_customer_name text;
  v_booking_ref text;
  v_invoice_token text;
  v_event_id uuid;
  v_academy_player_name text;
  v_academy_group_name text;
  v_academy_subscription_id uuid;
  v_academy_start_date date;
  v_academy_end_date date;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id;

  select id into v_pending_subscription_id from public.subscriptions
  where invoice_id = p_invoice_id and status = 'pending'
  limit 1;

  if v_pending_subscription_id is not null then
    perform public._activate_subscription_if_due_internal(v_pending_subscription_id);
  end if;

  select id into v_pending_membership_id from public.club_membership_subscriptions
  where invoice_id = p_invoice_id and status = 'pending_payment'
  limit 1;

  if v_pending_membership_id is not null then
    perform public._activate_club_membership_if_due_internal(v_pending_membership_id);
  end if;

  if p_new_outstanding <= 0 then
    select id into v_pending_booking_id from public.bookings
    where invoice_id = p_invoice_id and status = 'pending_payment'
    limit 1;

    if v_pending_booking_id is not null then
      update public.bookings set status = 'confirmed' where id = v_pending_booking_id and status = 'pending_payment';

      perform public.write_audit_log(
        v_invoice.club_id, 'booking.auto_confirmed_on_full_payment', 'bookings', v_pending_booking_id, null,
        jsonb_build_object('invoice_id', p_invoice_id, 'triggering_payment_id', p_payment_id),
        null
      );
    end if;
  end if;

  select name into v_club_name from public.clubs where id = v_invoice.club_id;
  select full_name into v_customer_name from public.customers where id = v_invoice.customer_id;
  select 'MB-' || upper(substring(id::text, 1, 8)) into v_booking_ref
    from public.bookings where invoice_id = p_invoice_id limit 1;

  -- p_created_by is null here -- there is no staff actor for a
  -- gateway-confirmed payment; _mint_invoice_token_internal's
  -- created_by column on invoice_verification_tokens already allows
  -- null (confirmed against the table's own schema before writing
  -- this call).
  v_invoice_token := public._mint_invoice_token_internal(p_invoice_id, v_invoice.club_id, null);

  select s.id, p.full_name, g.name, s.start_date, s.end_date
    into v_academy_subscription_id, v_academy_player_name, v_academy_group_name, v_academy_start_date, v_academy_end_date
  from public.subscriptions s
  join public.enrollments e on e.id = s.enrollment_id
  join public.players p on p.id = e.player_id
  join public.groups g on g.id = e.group_id
  where s.invoice_id = p_invoice_id
  limit 1;

  v_event_id := public.emit_notification_event(
    v_invoice.club_id, 'payment.received', 'payment', p_payment_id,
    jsonb_build_object('amount', p_amount, 'method', 'card', 'customer_id', v_invoice.customer_id, 'invoice_id', p_invoice_id, 'remaining_outstanding', p_new_outstanding)
  );

  if v_academy_subscription_id is not null then
    perform public.queue_whatsapp_notification(
      v_invoice.club_id, v_event_id, v_invoice.customer_id, 'academy-payment-received', 'payment_confirmations',
      jsonb_build_object(
        'amount', p_amount, 'invoice_number', v_invoice.invoice_number,
        'payment_status', case when p_new_outstanding <= 0 then 'paid' else 'partially_paid' end,
        'remaining_outstanding', p_new_outstanding, 'method', 'card',
        'club_name', v_club_name, 'customer_name', v_customer_name,
        'player_name', v_academy_player_name, 'group_name', v_academy_group_name,
        'subscription_start_date', v_academy_start_date, 'subscription_end_date', v_academy_end_date,
        'invoice_token', v_invoice_token, 'invoice_id', p_invoice_id,
        'receipt_serial', null, 'receipt_book', null, 'receipt_series', null, 'receipt_date', null
      ),
      'transactional', 'payment.received:' || p_payment_id::text,
      'document', 'invoice_pdf'
    );
    perform public.queue_email_notification(
      v_invoice.club_id, v_event_id, v_invoice.customer_id, 'academy-payment-received', 'payment_confirmations',
      jsonb_build_object(
        'amount', p_amount, 'invoice_number', v_invoice.invoice_number,
        'payment_status', case when p_new_outstanding <= 0 then 'paid' else 'partially_paid' end,
        'remaining_outstanding', p_new_outstanding, 'method', 'card',
        'club_name', v_club_name, 'customer_name', v_customer_name,
        'player_name', v_academy_player_name, 'group_name', v_academy_group_name,
        'subscription_start_date', v_academy_start_date, 'subscription_end_date', v_academy_end_date,
        'invoice_token', v_invoice_token, 'invoice_id', p_invoice_id,
        'receipt_serial', null, 'receipt_book', null, 'receipt_series', null, 'receipt_date', null
      ),
      'transactional', 'payment.received:' || p_payment_id::text
    );
  else
    perform public.queue_whatsapp_notification(
      v_invoice.club_id, v_event_id, v_invoice.customer_id, 'payment-received', 'payment_confirmations',
      jsonb_build_object(
        'amount', p_amount, 'invoice_number', v_invoice.invoice_number,
        'payment_status', case when p_new_outstanding <= 0 then 'paid' else 'partially_paid' end,
        'remaining_outstanding', p_new_outstanding, 'method', 'card',
        'club_name', v_club_name, 'customer_name', v_customer_name, 'booking_ref', v_booking_ref,
        'invoice_token', v_invoice_token, 'invoice_id', p_invoice_id,
        'receipt_serial', null, 'receipt_book', null, 'receipt_series', null, 'receipt_date', null
      ),
      'transactional', 'payment.received:' || p_payment_id::text,
      'document', 'invoice_pdf'
    );
    perform public.queue_email_notification(
      v_invoice.club_id, v_event_id, v_invoice.customer_id, 'payment-received', 'payment_confirmations',
      jsonb_build_object(
        'amount', p_amount, 'invoice_number', v_invoice.invoice_number,
        'payment_status', case when p_new_outstanding <= 0 then 'paid' else 'partially_paid' end,
        'remaining_outstanding', p_new_outstanding, 'method', 'card',
        'club_name', v_club_name, 'customer_name', v_customer_name, 'booking_ref', v_booking_ref,
        'invoice_token', v_invoice_token, 'invoice_id', p_invoice_id,
        'receipt_serial', null, 'receipt_book', null, 'receipt_series', null, 'receipt_date', null
      ),
      'transactional', 'payment.received:' || p_payment_id::text
    );
  end if;
end;
$function$;

revoke all on function public._apply_gateway_payment_side_effects_internal(uuid, uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public._apply_gateway_payment_side_effects_internal(uuid, uuid, numeric, numeric) to service_role;

-- ---------------------------------------------------------------------
-- record_gateway_payment_service: the ONLY path by which a payment
-- gateway webhook (or, later, an explicit server-side status-poll
-- against a provider's own API) may post a canonical public.payments
-- row. service_role-only. Never reachable from anon/authenticated --
-- there is no end-user session shape this could ever be safely called
-- under, since the caller-authentication model here is "the webhook
-- Edge Function already verified the provider's signature", which by
-- definition cannot be proven inside Postgres itself.
-- ---------------------------------------------------------------------
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
  -- same invoice.
  select * into v_txn from public.payment_gateway_transactions where id = p_transaction_id for update;

  if v_txn.id is null then
    raise exception 'gateway transaction not found';
  end if;

  -- Idempotency / replay defense: a webhook retried after the first
  -- delivery already posted the payment (or after the transaction was
  -- already marked failed/cancelled by a prior delivery) must not
  -- reprocess. Since payment_id is set atomically with status in the
  -- success path below, returning the already-linked payment id here
  -- makes a retried "succeeded" webhook delivery a true no-op instead
  -- of an error -- matching record_payment()'s own idempotency-key
  -- early-return shape.
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
  -- payment is posted, ever.
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

    raise exception 'confirmed amount (%) does not match staged transaction amount (%) -- payment rejected', p_confirmed_amount, v_txn.amount;
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

    raise exception 'confirmed currency (%) does not match staged transaction currency (%) -- payment rejected', p_confirmed_currency, v_txn.currency;
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
    raise exception 'invoice not found -- payment rejected';
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

    raise exception 'invoice is no longer issued (status: %) -- payment rejected, will not double-post', v_invoice.status;
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

    raise exception 'confirmed amount (%) exceeds outstanding balance (%) -- payment rejected', p_confirmed_amount, v_outstanding;
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

revoke all on function public.record_gateway_payment_service(uuid, numeric, text, text, text) from public, anon, authenticated;
grant execute on function public.record_gateway_payment_service(uuid, numeric, text, text, text) to service_role;

-- ---------------------------------------------------------------------
-- mark_gateway_transaction_failed_service: for signature-verification
-- failure, provider-reported decline/cancellation, or any other
-- "this checkout did not succeed" outcome. Never touches
-- payments/payment_allocations. service_role-only.
-- ---------------------------------------------------------------------
create or replace function public.mark_gateway_transaction_failed_service(
  p_transaction_id uuid,
  p_reason text,
  p_provider_raw_status text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_txn public.payment_gateway_transactions;
begin
  select * into v_txn from public.payment_gateway_transactions where id = p_transaction_id for update;

  if v_txn.id is null then
    raise exception 'gateway transaction not found';
  end if;

  -- Only a transaction still in 'pending' can transition to 'failed'
  -- here -- an already-succeeded transaction must never be flipped to
  -- failed by a late/out-of-order webhook delivery (e.g. a delayed
  -- 'payment_intent.payment_failed' arriving after a 'checkout.session
  -- .completed' already posted the payment). Already-failed/cancelled
  -- is a harmless no-op (idempotent under retry).
  if v_txn.status = 'succeeded' then
    raise exception 'gateway transaction already succeeded -- refusing to mark it failed';
  end if;

  if v_txn.status = 'pending' then
    update public.payment_gateway_transactions
    set status = 'failed',
        failure_reason = p_reason,
        provider_raw_status = coalesce(p_provider_raw_status, provider_raw_status),
        updated_at = now()
    where id = p_transaction_id;

    perform public.write_audit_log(
      v_txn.club_id, 'payment.gateway_failed', 'payment_gateway_transaction', p_transaction_id, null,
      jsonb_build_object('reason', p_reason, 'provider_raw_status', p_provider_raw_status),
      null
    );
  end if;
  -- else: already 'failed' or 'cancelled' -- idempotent no-op.
end;
$function$;

revoke all on function public.mark_gateway_transaction_failed_service(uuid, text, text) from public, anon, authenticated;
grant execute on function public.mark_gateway_transaction_failed_service(uuid, text, text) to service_role;

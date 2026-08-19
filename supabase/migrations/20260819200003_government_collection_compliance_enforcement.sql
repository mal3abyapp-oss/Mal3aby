-- Government / Ministry Collection Compliance -- Enforcement (directive
-- sections 15-18, 34, 42, 68).
--
-- THIS IS THE HARD BLOCK. Per directive section 15/16: "even if the
-- user tries to bypass the UI or call the RPC directly, server-side
-- business logic must prevent it." Confirmed via the earlier audit
-- that `record_payment()` is the single place ALL THREE entry points
-- (direct staff payment, approve_payment_proof, verify_manual_payment_claim)
-- converge to move a payment to a terminal state and auto-confirm the
-- booking. Modifying record_payment() itself -- rather than only
-- adding a new wrapper RPC -- is the only way to guarantee no bypass
-- path exists, since a parallel wrapper could always be skipped by
-- calling record_payment() directly (exactly the vulnerability the
-- directive explicitly tests for in section 70).
--
-- The block only fires when:
--   1. The effective government policy for this payment's booking's
--      field (falling back to branch, falling back to club) has
--      official_receipt_required = true, AND
--   2. p_method is in that policy's required_payment_methods array.
-- A non-government club, or a government club paying by a method not
-- in its required list, is completely unaffected -- directive section
-- 48: "Club where compliance = OFF: existing payment flow must behave
-- exactly as before."
--
-- Directive section 36: NO RETROACTIVE ENFORCEMENT. This block only
-- evaluates the CURRENT effective policy at the moment record_payment()
-- runs -- it has no knowledge of, and does not touch, any payment
-- already recorded before this migration. A club enabling compliance
-- today does not retroactively invalidate money already collected.

begin;

create or replace function public.record_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_method text,
  p_reference text default null,
  p_idempotency_key uuid default null,
  p_official_receipt_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_invoice record;
  v_payment_id uuid;
  v_existing_payment_id uuid;
  v_pending_subscription_id uuid;
  v_outstanding numeric;
  v_event_id uuid;
  v_new_outstanding numeric;
  v_pending_booking_id uuid;
  v_club_name text;
  v_customer_name text;
  v_booking_ref text;
  v_invoice_token text;
  v_booking_field_id uuid;
  v_booking_branch_id uuid;
  v_effective_policy public.government_collection_policies;
  v_receipt record;
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

  if p_idempotency_key is not null then
    select id into v_existing_payment_id
    from public.payments
    where club_id = v_invoice.club_id and idempotency_key = p_idempotency_key;

    if v_existing_payment_id is not null then
      return v_existing_payment_id;
    end if;
  end if;

  if not public.club_write_allowed(v_invoice.club_id, 'settle_existing') then
    raise exception 'club subscription does not allow settling existing balances';
  end if;

  if v_invoice.status != 'issued' then
    raise exception 'can only record payment against an issued invoice';
  end if;

  perform 1 from public.invoices where id = p_invoice_id for update;

  -- ============================================================
  -- GOVERNMENT COMPLIANCE HARD BLOCK -- directive section 15.
  -- ============================================================
  -- Resolve the booking (if any) linked to this invoice, to get its
  -- field/branch for policy inheritance. An invoice with no linked
  -- booking (e.g. a standalone academy invoice) resolves policy at
  -- club level only, since there's no field context.
  select b.field_id, b.branch_id into v_booking_field_id, v_booking_branch_id
  from public.bookings b where b.invoice_id = p_invoice_id limit 1;

  v_effective_policy := public.get_effective_government_policy(
    v_invoice.club_id, v_booking_branch_id, v_booking_field_id
  );

  if v_effective_policy.enabled
     and v_effective_policy.official_receipt_required
     and p_method = any(v_effective_policy.required_payment_methods)
  then
    if p_official_receipt_id is null then
      raise exception 'official collection receipt required: this club/field requires an official government collection receipt for % payments' , p_method;
    end if;

    -- Validate the receipt actually belongs to this club, is active,
    -- and isn't already attached to a different payment -- defense in
    -- depth even though record_payment_with_official_receipt() (the
    -- normal caller) creates the receipt and payment together.
    select * into v_receipt from public.official_collection_receipts
    where id = p_official_receipt_id and club_id = v_invoice.club_id and status = 'active';

    if v_receipt is null then
      raise exception 'official collection receipt not found, not active, or does not belong to this club';
    end if;

    if v_receipt.payment_id is not null then
      raise exception 'this official collection receipt is already linked to a payment';
    end if;

    if v_receipt.receipt_amount != p_amount then
      raise exception 'official collection receipt amount (%) does not match the payment amount (%)', v_receipt.receipt_amount, p_amount;
    end if;
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

  insert into public.payments (club_id, branch_id, customer_id, method, amount, reference, received_by, idempotency_key)
  values (v_invoice.club_id, v_invoice.branch_id, v_invoice.customer_id, p_method, p_amount, p_reference, auth.uid(), p_idempotency_key)
  returning id into v_payment_id;

  -- Link the (now-validated) receipt to this payment atomically, in
  -- the same transaction as the payment insert -- directive section
  -- 18: never a state where payment=paid but receipt insert failed,
  -- or receipt created but payment rolled back leaving it orphaned.
  -- booking_id is filled in later below, once the booking-confirm
  -- step resolves it (v_pending_booking_id is not known yet at this
  -- point in the function).
  if p_official_receipt_id is not null and v_receipt.id is not null then
    update public.official_collection_receipts
    set payment_id = v_payment_id, invoice_id = p_invoice_id,
        customer_id = v_invoice.customer_id, updated_at = now()
    where id = p_official_receipt_id;

    perform public.write_audit_log(
      v_invoice.club_id, 'official_collection_receipt.created', 'official_collection_receipt', p_official_receipt_id,
      null,
      jsonb_build_object('payment_id', v_payment_id, 'receipt_serial', v_receipt.receipt_serial, 'amount', p_amount),
      null
    );
  end if;

  perform public.write_audit_log(
    v_invoice.club_id, 'payment.record', 'payment', v_payment_id, null,
    jsonb_build_object('amount', p_amount, 'method', p_method, 'invoice_id', p_invoice_id, 'official_receipt_id', p_official_receipt_id),
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

  if v_new_outstanding <= 0 then
    select id into v_pending_booking_id from public.bookings
    where invoice_id = p_invoice_id and status = 'pending_payment'
    limit 1;

    if v_pending_booking_id is not null then
      update public.bookings set status = 'confirmed' where id = v_pending_booking_id;

      -- Backfill booking_id on the receipt now that we know it, if it
      -- wasn't resolvable earlier (booking may not have existed as
      -- 'pending_payment' until this exact moment in edge cases).
      if p_official_receipt_id is not null then
        update public.official_collection_receipts
        set booking_id = v_pending_booking_id
        where id = p_official_receipt_id and booking_id is null;
      end if;

      perform public.write_audit_log(
        v_invoice.club_id, 'booking.auto_confirmed_on_full_payment', 'bookings', v_pending_booking_id, null,
        jsonb_build_object('invoice_id', p_invoice_id, 'triggering_payment_id', v_payment_id),
        null
      );
    end if;
  end if;

  select name into v_club_name from public.clubs where id = v_invoice.club_id;
  select full_name into v_customer_name from public.customers where id = v_invoice.customer_id;
  select 'MB-' || upper(substring(id::text, 1, 8)) into v_booking_ref
    from public.bookings where invoice_id = p_invoice_id limit 1;

  v_invoice_token := public._mint_invoice_token_internal(p_invoice_id, v_invoice.club_id, auth.uid());

  v_event_id := public.emit_notification_event(
    v_invoice.club_id, 'payment.received', 'payment', v_payment_id,
    jsonb_build_object('amount', p_amount, 'method', p_method, 'customer_id', v_invoice.customer_id, 'invoice_id', p_invoice_id, 'remaining_outstanding', v_new_outstanding)
  );

  -- MEDIA: payment-received carries the invoice PDF.
  perform public.queue_whatsapp_notification(
    v_invoice.club_id, v_event_id, v_invoice.customer_id, 'payment-received', 'payment_confirmations',
    jsonb_build_object(
      'amount', p_amount, 'invoice_number', v_invoice.invoice_number,
      'payment_status', case when v_new_outstanding <= 0 then 'paid' else 'partially_paid' end,
      'remaining_outstanding', v_new_outstanding, 'method', p_method,
      'club_name', v_club_name, 'customer_name', v_customer_name, 'booking_ref', v_booking_ref,
      'invoice_token', v_invoice_token, 'invoice_id', p_invoice_id
    ),
    'transactional', 'payment.received:' || v_payment_id::text,
    'document', 'invoice_pdf'
  );

  return v_payment_id;
end;
$function$;

-- Grants unchanged from the original function (authenticated only,
-- confirmed already correct in the live audit) -- re-affirm explicitly
-- since this is a full CREATE OR REPLACE, not an ALTER.
revoke all on function public.record_payment(uuid, numeric, text, text, uuid, uuid) from public;
revoke all on function public.record_payment(uuid, numeric, text, text, uuid, uuid) from anon;
grant execute on function public.record_payment(uuid, numeric, text, text, uuid, uuid) to authenticated;

-- CRITICAL: the new 6-arg signature is an ADDITIONAL overload in
-- Postgres, not a replacement of the original 5-arg one -- if left in
-- place, the old 5-arg record_payment(...) would still exist with NO
-- compliance check at all, a complete bypass of the hard block above.
-- Drop it explicitly so exactly one record_payment() exists.
drop function if exists public.record_payment(uuid, numeric, text, text, uuid);

commit;

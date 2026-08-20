-- Phase D RPCs: shift-required-for-custody-cash gate (D2), payment/
-- refund shift linkage (D5), liability creation on shift close (D10/
-- D11), settlement/adjustment (D12/D13/D14), and staff-facing read
-- RPCs (D16).

begin;

-- D2: if the collecting staff member has cash custody, a cash payment
-- can only be recorded while they have an active shift on that branch.
-- Someone WITHOUT custody (has_cash_custody = false, the default) is
-- entirely unaffected -- this directive is explicit that custody is
-- what triggers the requirement, not the mere existence of the
-- cash_shifts feature. D5: the resulting payment is linked to that
-- shift explicitly via cash_shift_id.
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
  v_receipt_validated boolean := false;
  v_has_custody boolean;
  v_active_shift_id uuid;
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

  select b.field_id, b.branch_id into v_booking_field_id, v_booking_branch_id
  from public.bookings b where b.invoice_id = p_invoice_id limit 1;

  -- Phase D (D2/D5): only applies to cash -- other methods never touch
  -- the drawer, so shift custody is irrelevant to them.
  if p_method = 'cash' then
    select coalesce(bool_or(has_cash_custody), false) into v_has_custody
    from public.club_memberships
    where user_id = auth.uid() and club_id = v_invoice.club_id and status = 'active';

    if v_has_custody then
      if v_booking_branch_id is null then
        raise exception 'cash collection requires a branch-scoped booking -- this invoice has none';
      end if;

      select id into v_active_shift_id
      from public.cash_shifts
      where branch_id = v_booking_branch_id and opened_by = auth.uid() and status = 'open';

      if v_active_shift_id is null then
        raise exception 'cash collection requires an active cash shift -- open one before collecting cash';
      end if;
    end if;
  end if;

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

    select * into v_receipt from public.official_collection_receipts
    where id = p_official_receipt_id and club_id = v_invoice.club_id and status = 'active';

    if v_receipt is null then
      raise exception 'official collection receipt not found, not active, or does not belong to this club';
    end if;
    v_receipt_validated := true;

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

  insert into public.payments (club_id, branch_id, customer_id, method, amount, reference, received_by, idempotency_key, cash_shift_id)
  values (v_invoice.club_id, v_invoice.branch_id, v_invoice.customer_id, p_method, p_amount, p_reference, auth.uid(), p_idempotency_key, v_active_shift_id)
  returning id into v_payment_id;

  if v_receipt_validated then
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
    jsonb_build_object('amount', p_amount, 'method', p_method, 'invoice_id', p_invoice_id, 'official_receipt_id', p_official_receipt_id, 'cash_shift_id', v_active_shift_id),
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

      if v_receipt_validated then
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

  perform public.queue_whatsapp_notification(
    v_invoice.club_id, v_event_id, v_invoice.customer_id, 'payment-received', 'payment_confirmations',
    jsonb_build_object(
      'amount', p_amount, 'invoice_number', v_invoice.invoice_number,
      'payment_status', case when v_new_outstanding <= 0 then 'paid' else 'partially_paid' end,
      'remaining_outstanding', v_new_outstanding, 'method', p_method,
      'club_name', v_club_name, 'customer_name', v_customer_name, 'booking_ref', v_booking_ref,
      'invoice_token', v_invoice_token, 'invoice_id', p_invoice_id,
      -- Directive Sections 4/7: include official receipt details in the
      -- customer-facing message when this payment has one, same fields
      -- as booking-confirmed-paid's own receipt block (serial/book/
      -- series/date only, no internal metadata).
      'receipt_serial', case when v_receipt_validated then v_receipt.receipt_serial else null end,
      'receipt_book', case when v_receipt_validated then v_receipt.receipt_book else null end,
      'receipt_series', case when v_receipt_validated then v_receipt.receipt_series else null end,
      'receipt_date', case when v_receipt_validated then v_receipt.receipt_date else null end
    ),
    'transactional', 'payment.received:' || v_payment_id::text,
    'document', 'invoice_pdf'
  );

  return v_payment_id;
end;
$function$;

-- D1: set/unset custody, owner/manager-only (same permission the rest
-- of staff management already uses).
create or replace function public.set_staff_cash_custody(
  p_membership_id uuid,
  p_has_custody boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_membership record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_membership from public.club_memberships where id = p_membership_id;
  if v_membership.id is null then
    raise exception 'membership not found';
  end if;

  if not (v_membership.club_id in (select public.user_club_ids()) and public.has_permission('staff.update', v_membership.club_id)) then
    raise exception 'not authorized';
  end if;

  update public.club_memberships set has_cash_custody = p_has_custody, updated_at = now()
  where id = p_membership_id;

  perform public.write_audit_log(
    v_membership.club_id, 'staff.cash_custody.set', 'club_membership', p_membership_id,
    jsonb_build_object('has_cash_custody', v_membership.has_cash_custody),
    jsonb_build_object('has_cash_custody', p_has_custody),
    null
  );
end;
$$;

revoke execute on function public.set_staff_cash_custody(uuid, boolean) from public, anon;
grant execute on function public.set_staff_cash_custody(uuid, boolean) to authenticated;

commit;

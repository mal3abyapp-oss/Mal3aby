-- Phase 14 -- Audit Log + Security Hardening (Independent Verification Pass).
-- See docs/IMPLEMENTATION_PLAN.md Phase 14, docs/SECURITY_ANTI_FRAUD.md
-- (canonical audit-scope list), docs/RLS_SECURITY.md (verification
-- checklist), docs/DECISIONS.md ADR-020 (audit logs immutable).
--
-- Independent re-verification found the canonical audit-scope list
-- (SECURITY_ANTI_FRAUD.md) was under-covered by 5 real gaps against what
-- was actually wired in Phase 3c/6/7/11: booking created, discount
-- applied, field block created, payment recorded, refund, subscription
-- activated. This migration closes those 5 gaps by redefining the
-- relevant functions with an added write_audit_log call -- behavior is
-- otherwise byte-identical to the prior definition.

-- ============================================================
-- _create_booking_internal: add booking-created (+ discount-applied when
-- p_discount_amount > 0) audit entries. No other behavior change.
-- ============================================================

create or replace function public._create_booking_internal(
  p_field_id uuid,
  p_customer_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_discount_amount numeric,
  p_notes text,
  p_record_payment boolean,
  p_payment_method text,
  p_payment_amount numeric,
  p_booking_series_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_branch_id uuid;
  v_field record;
  v_price_per_hour numeric;
  v_hours numeric;
  v_total_price numeric;
  v_booking_id uuid;
  v_invoice_id uuid;
  v_invoice_number text;
  v_payment_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id, branch_id into v_club_id, v_branch_id from public.fields where id = p_field_id;
  if v_club_id is null then
    raise exception 'field not found';
  end if;
  select * into v_field from public.fields where id = p_field_id;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('booking.create', v_club_id)) then
    raise exception 'not authorized';
  end if;

  if not public.club_write_allowed(v_club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new bookings';
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id and club_id = v_club_id) then
    raise exception 'customer not found in this club';
  end if;

  if p_booking_series_id is not null and not exists (
    select 1 from public.booking_series
    where id = p_booking_series_id
      and club_id = v_club_id
      and field_id = p_field_id
      and customer_id = p_customer_id
  ) then
    raise exception 'booking series does not match this club/field/customer';
  end if;

  if p_end_at <= p_start_at then
    raise exception 'end time must be after start time';
  end if;

  if exists (
    select 1 from public.field_blocks
    where field_id = p_field_id
      and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then
    raise exception 'field is blocked during this time';
  end if;

  v_price_per_hour := public.resolve_field_price(
    p_field_id, p_start_at::date, p_start_at::time, p_end_at::time
  );
  v_hours := extract(epoch from (p_end_at - p_start_at)) / 3600.0;
  v_total_price := round(v_price_per_hour * v_hours, 2);

  if p_discount_amount > 0 then
    if not public.has_permission('booking.discount.apply', v_club_id) then
      raise exception 'not authorized to apply a discount';
    end if;
    if p_discount_amount > v_total_price * 0.3 and not public.has_permission('booking.discount.override', v_club_id) then
      raise exception 'discount exceeds the standard limit -- requires override permission';
    end if;
  end if;

  insert into public.bookings (
    club_id, branch_id, field_id, customer_id, start_at, end_at,
    status, total_price, discount_amount, notes, booking_series_id, created_by
  ) values (
    v_club_id, v_branch_id, p_field_id, p_customer_id, p_start_at, p_end_at,
    'pending_payment', v_total_price, p_discount_amount, p_notes, p_booking_series_id, auth.uid()
  ) returning id into v_booking_id;

  perform public.write_audit_log(
    v_club_id, 'booking.create', 'booking', v_booking_id, null,
    jsonb_build_object('field_id', p_field_id, 'customer_id', p_customer_id, 'total_price', v_total_price, 'discount_amount', p_discount_amount),
    null
  );

  if p_discount_amount > 0 then
    perform public.write_audit_log(
      v_club_id, 'booking.discount.apply', 'booking', v_booking_id, null,
      jsonb_build_object('discount_amount', p_discount_amount, 'total_price', v_total_price),
      null
    );
  end if;

  v_invoice_number := public.issue_invoice_number(v_branch_id, v_club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch_id, v_invoice_number, p_customer_id, 'issued', v_total_price, p_discount_amount, v_total_price - p_discount_amount, now(), auth.uid())
  returning id into v_invoice_id;

  perform public.write_audit_log(
    v_club_id, 'invoice.issue', 'invoice', v_invoice_id, null,
    jsonb_build_object('invoice_number', v_invoice_number, 'total', v_total_price - p_discount_amount),
    null
  );

  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'حجز ' || v_field.name, 'booking', v_booking_id, v_hours, v_price_per_hour, v_total_price - p_discount_amount);

  update public.bookings set invoice_id = v_invoice_id where id = v_booking_id;

  if p_record_payment and p_payment_amount is not null and p_payment_amount > 0 then
    if not public.has_permission('payment.create', v_club_id) then
      raise exception 'not authorized to record a payment';
    end if;

    insert into public.payments (club_id, branch_id, customer_id, method, amount, received_by)
    values (v_club_id, v_branch_id, p_customer_id, coalesce(p_payment_method, 'cash'), p_payment_amount, auth.uid())
    returning id into v_payment_id;

    perform public.write_audit_log(
      v_club_id, 'payment.record', 'payment', v_payment_id, null,
      jsonb_build_object('amount', p_payment_amount, 'method', coalesce(p_payment_method, 'cash'), 'invoice_id', v_invoice_id),
      null
    );

    insert into public.payment_allocations (payment_id, invoice_id, amount)
    values (v_payment_id, v_invoice_id, least(p_payment_amount, v_total_price - p_discount_amount));

    update public.bookings set status = 'confirmed' where id = v_booking_id;
  end if;

  return v_booking_id;
end;
$$;

revoke execute on function public._create_booking_internal(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric, uuid) from public;
revoke execute on function public._create_booking_internal(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric, uuid) from anon;
revoke execute on function public._create_booking_internal(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric, uuid) from authenticated;

-- ============================================================
-- create_field_block: add field-block-created audit entry.
-- ============================================================

create or replace function public.create_field_block(
  p_field_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_type text,
  p_reason text default null
)
returns table(block_id uuid, conflicting_booking_ids uuid[])
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_block_id uuid;
  v_conflicts uuid[];
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id into v_club_id from public.fields where id = p_field_id;
  if v_club_id is null then
    raise exception 'field not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('field.update', v_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_type not in ('maintenance', 'weather', 'private_event', 'manual', 'holiday') then
    raise exception 'invalid block type';
  end if;

  select array_agg(id) into v_conflicts
  from public.bookings
  where field_id = p_field_id
    and status in ('pending_payment', 'confirmed', 'checked_in')
    and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)');

  insert into public.field_blocks (club_id, field_id, start_at, end_at, reason, type, created_by)
  values (v_club_id, p_field_id, p_start_at, p_end_at, p_reason, p_type, auth.uid())
  returning id into v_block_id;

  perform public.write_audit_log(
    v_club_id, 'field_block.create', 'field_block', v_block_id, null,
    jsonb_build_object('field_id', p_field_id, 'type', p_type, 'conflicting_booking_ids', coalesce(v_conflicts, array[]::uuid[])),
    p_reason
  );

  return query select v_block_id, coalesce(v_conflicts, array[]::uuid[]);
end;
$$;

revoke execute on function public.create_field_block(uuid, timestamptz, timestamptz, text, text) from public;
revoke execute on function public.create_field_block(uuid, timestamptz, timestamptz, text, text) from anon;
grant execute on function public.create_field_block(uuid, timestamptz, timestamptz, text, text) to authenticated;

-- ============================================================
-- record_payment: add payment-recorded audit entry (booking-bundled
-- payments already got one above via _create_booking_internal --
-- this covers the standalone record_payment path used for installments/
-- outstanding-balance settlement).
-- ============================================================

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

  return v_payment_id;
end;
$$;

revoke execute on function public.record_payment(uuid, numeric, text, text) from public;
revoke execute on function public.record_payment(uuid, numeric, text, text) from anon;
grant execute on function public.record_payment(uuid, numeric, text, text) to authenticated;

-- ============================================================
-- create_refund: add refund audit entry.
-- ============================================================

create or replace function public.create_refund(
  p_payment_id uuid,
  p_amount numeric,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment record;
  v_refunded_sum numeric;
  v_refund_id uuid;
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

  if not (v_payment.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', v_payment.club_id)) then
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

  insert into public.refunds (payment_id, amount, reason, status, refunded_by)
  values (p_payment_id, p_amount, p_reason, 'completed', auth.uid())
  returning id into v_refund_id;

  perform public.write_audit_log(
    v_payment.club_id, 'payment.refund', 'refund', v_refund_id, null,
    jsonb_build_object('payment_id', p_payment_id, 'amount', p_amount),
    p_reason
  );

  return v_refund_id;
end;
$$;

revoke execute on function public.create_refund(uuid, numeric, text) from public;
revoke execute on function public.create_refund(uuid, numeric, text) from anon;
grant execute on function public.create_refund(uuid, numeric, text) to authenticated;

-- ============================================================
-- _activate_subscription_if_due_internal: add subscription-activated
-- audit entry (fires regardless of which policy branch activated it, or
-- whether the caller was the public wrapper or record_payment's internal
-- call -- club_id is always known at this point so write_audit_log's own
-- auth.uid()-derived actor is correct either way).
-- ============================================================

create or replace function public._activate_subscription_if_due_internal(p_subscription_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub record;
  v_policy text;
  v_paid numeric;
  v_total numeric;
  v_activated boolean := false;
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if v_sub.id is null then
    raise exception 'subscription not found';
  end if;

  if v_sub.status != 'pending' then
    return false;
  end if;

  select subscription_activation_policy into v_policy from public.clubs where id = v_sub.club_id;

  if v_policy = 'manual' then
    update public.subscriptions set status = 'active' where id = p_subscription_id;
    v_activated := true;
  else
    select i.total, coalesce(sum(pa.amount), 0) into v_total, v_paid
    from public.invoices i
    left join public.payment_allocations pa on pa.invoice_id = i.id
    where i.id = v_sub.invoice_id
    group by i.total;

    if v_policy = 'first_payment' and v_paid > 0 then
      update public.subscriptions set status = 'active' where id = p_subscription_id;
      v_activated := true;
    elsif v_policy = 'full_payment' and v_paid >= v_total then
      update public.subscriptions set status = 'active' where id = p_subscription_id;
      v_activated := true;
    end if;
  end if;

  if v_activated then
    perform public.write_audit_log(
      v_sub.club_id, 'subscription.activate', 'subscription', p_subscription_id, null,
      jsonb_build_object('policy', v_policy),
      null
    );
  end if;

  return v_activated;
end;
$$;

revoke execute on function public._activate_subscription_if_due_internal(uuid) from public;
revoke execute on function public._activate_subscription_if_due_internal(uuid) from anon;
revoke execute on function public._activate_subscription_if_due_internal(uuid) from authenticated;

-- V1 Implementation Gap Audit (2026-08-16): field_operating_hours existed
-- in the schema (docs/DATABASE_BLUEPRINT.md), with full RLS CRUD policies
-- already in place, but was never actually enforced anywhere -- a booking
-- could be created at any time of day regardless of a field's configured
-- hours, and the table was confirmed completely empty across every club
-- in the live database (nobody had a way to populate it -- no UI existed
-- either, fixed separately in this same pass).
--
-- Enforcement semantics: field_operating_hours follows the same
-- "empty = unrestricted" convention as membership_branches
-- (has_branch_access) and closely mirrors the field_id-nullable
-- branch-fallback pattern pricing_rules already uses. If NO rows exist
-- at all for a field (checking field-specific rows, then falling back to
-- branch-level field_id IS NULL rows), the field is treated as open
-- 24/7 -- this is the only safe default given every existing club's
-- fields currently have zero configured hours; a hard "no hours
-- configured = reject all bookings" would have broken booking for every
-- real club using the product today. Once a club configures hours for a
-- given day_of_week (via the new UI), that day's bookings are strictly
-- bounded by open_time/close_time; a day_of_week with no matching row
-- for a field/branch that DOES have other configured days is treated as
-- closed that day (an explicit gap in an otherwise-configured week means
-- "not open"), matching the spec's per-weekday model.
create or replace function public.resolve_field_operating_hours(p_field_id uuid, p_date date)
returns table(open_time time, close_time time, has_any_config boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_branch_id uuid;
  v_day_of_week int;
  v_any_field_rows boolean;
  v_any_branch_rows boolean;
begin
  select club_id, branch_id into v_club_id, v_branch_id from public.fields where id = p_field_id;
  if v_club_id is null then
    raise exception 'field not found';
  end if;

  v_day_of_week := extract(dow from p_date)::int;

  select exists(select 1 from public.field_operating_hours where field_id = p_field_id)
    into v_any_field_rows;

  if v_any_field_rows then
    return query
      select foh.open_time, foh.close_time, true
      from public.field_operating_hours foh
      where foh.field_id = p_field_id and foh.day_of_week = v_day_of_week;
    if not found then
      -- field has some configured days but not this one -> closed today
      return query select null::time, null::time, true;
    end if;
    return;
  end if;

  select exists(select 1 from public.field_operating_hours where field_id is null and branch_id = v_branch_id)
    into v_any_branch_rows;

  if v_any_branch_rows then
    return query
      select foh.open_time, foh.close_time, true
      from public.field_operating_hours foh
      where foh.field_id is null and foh.branch_id = v_branch_id and foh.day_of_week = v_day_of_week;
    if not found then
      return query select null::time, null::time, true;
    end if;
    return;
  end if;

  -- No configuration anywhere for this field or its branch -> unrestricted.
  return query select null::time, null::time, false;
end;
$$;

revoke execute on function public.resolve_field_operating_hours(uuid, date) from public;
revoke execute on function public.resolve_field_operating_hours(uuid, date) from anon;
grant execute on function public.resolve_field_operating_hours(uuid, date) to authenticated;

-- _create_booking_internal: add the operating-hours check right after the
-- existing field_blocks check, before price resolution. A booking may
-- span at most one calendar day for this check (matches how pricing
-- already resolves against p_start_at::date) -- multi-day bookings are
-- not a V1 concept per USER_FLOWS.md.
create or replace function public._create_booking_internal(p_field_id uuid, p_customer_id uuid, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_discount_amount numeric, p_notes text, p_record_payment boolean, p_payment_method text, p_payment_amount numeric, p_booking_series_id uuid)
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
  v_hours_row record;
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

  if p_start_at::date <> (p_end_at - interval '1 second')::date then
    raise exception 'a booking cannot span more than one calendar day';
  end if;

  select * into v_hours_row from public.resolve_field_operating_hours(p_field_id, p_start_at::date);
  if v_hours_row.has_any_config and v_hours_row.open_time is null then
    raise exception 'field is closed on this day';
  end if;
  if v_hours_row.has_any_config and (p_start_at::time < v_hours_row.open_time or p_end_at::time > v_hours_row.close_time) then
    raise exception 'booking time is outside the field''s operating hours (% - %)', v_hours_row.open_time, v_hours_row.close_time;
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

-- Phase 6 — Booking Engine RPCs: create_booking, create_recurring_booking,
-- create_field_block, cancel_booking, mark_no_show. Follows the exact
-- checklist in docs/SECURITY_ANTI_FRAUD.md#booking-security and
-- docs/RLS_SECURITY.md.

-- ============================================================
-- issue_invoice_number: concurrency-safe per-branch numbering.
-- UPDATE ... RETURNING inside a single statement -- no SELECT-then-UPDATE
-- race window, matching invoice_number_sequences' documented discipline.
-- Not directly client-callable (no EXECUTE grant) -- internal helper only.
-- ============================================================
create or replace function public.issue_invoice_number(p_branch_id uuid, p_club_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_code text;
  v_branch_code text;
  v_year int := extract(year from now())::int;
  v_next bigint;
begin
  select club_code into v_club_code from public.clubs where id = p_club_id;
  select branch_code into v_branch_code from public.branches where id = p_branch_id;

  insert into public.invoice_number_sequences (branch_id, year, last_number)
  values (p_branch_id, v_year, 1)
  on conflict (branch_id, year) do update set last_number = invoice_number_sequences.last_number + 1
  returning last_number into v_next;

  return v_club_code || '-' || v_branch_code || '-' || v_year || '-' || lpad(v_next::text, 6, '0');
end;
$$;

revoke execute on function public.issue_invoice_number(uuid, uuid) from public;
revoke execute on function public.issue_invoice_number(uuid, uuid) from anon;
revoke execute on function public.issue_invoice_number(uuid, uuid) from authenticated;

-- ============================================================
-- create_booking: validate -> booking -> invoice -> optional payment ->
-- allocation, one transaction. Follows SECURITY_ANTI_FRAUD.md's 9-step
-- checklist in order.
-- ============================================================
create or replace function public.create_booking(
  p_field_id uuid,
  p_customer_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_discount_amount numeric default 0,
  p_notes text default null,
  p_record_payment boolean default false,
  p_payment_method text default null,
  p_payment_amount numeric default null,
  p_booking_series_id uuid default null
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
  -- 1. Caller is authenticated.
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  -- Derive club_id from the field being booked -- never trust a
  -- client-supplied club_id (no such parameter exists on this function).
  select club_id, branch_id into v_club_id, v_branch_id from public.fields where id = p_field_id;
  if v_club_id is null then
    raise exception 'field not found';
  end if;
  select * into v_field from public.fields where id = p_field_id;

  -- 2 & 3. Caller holds an active membership with booking.create.
  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('booking.create', v_club_id)) then
    raise exception 'not authorized';
  end if;

  -- 4. Platform access allows new commitments.
  if not public.club_write_allowed(v_club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new bookings';
  end if;

  -- 9. Customer exists and belongs to the same club.
  if not exists (select 1 from public.customers where id = p_customer_id and club_id = v_club_id) then
    raise exception 'customer not found in this club';
  end if;

  -- If a series is claimed, it must genuinely belong to the same club --
  -- bookkeeping-only linkage (ADR-047), never trusted for authorization,
  -- conflict-checking, or financial behavior.
  if p_booking_series_id is not null and not exists (
    select 1 from public.booking_series where id = p_booking_series_id and club_id = v_club_id
  ) then
    raise exception 'booking series not found in this club';
  end if;

  if p_end_at <= p_start_at then
    raise exception 'end time must be after start time';
  end if;

  -- 6. Field block check -- reject if the window overlaps an active block.
  if exists (
    select 1 from public.field_blocks
    where field_id = p_field_id
      and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then
    raise exception 'field is blocked during this time';
  end if;

  -- 7. Price is always server-recomputed, never trusted from the client --
  -- there is no p_price parameter on this function at all.
  v_price_per_hour := public.resolve_field_price(
    p_field_id, p_start_at::date, p_start_at::time, p_end_at::time
  );
  v_hours := extract(epoch from (p_end_at - p_start_at)) / 3600.0;
  v_total_price := round(v_price_per_hour * v_hours, 2);

  -- 8. Discount permission check.
  if p_discount_amount > 0 then
    if not public.has_permission('booking.discount.apply', v_club_id) then
      raise exception 'not authorized to apply a discount';
    end if;
    if p_discount_amount > v_total_price * 0.3 and not public.has_permission('booking.discount.override', v_club_id) then
      raise exception 'discount exceeds the standard limit -- requires override permission';
    end if;
  end if;

  -- Insert the booking. The exclusion constraint is the final,
  -- unconditional line of defense against double-booking regardless of
  -- whether any check above was implemented correctly.
  insert into public.bookings (
    club_id, branch_id, field_id, customer_id, start_at, end_at,
    status, total_price, discount_amount, notes, booking_series_id, created_by
  ) values (
    v_club_id, v_branch_id, p_field_id, p_customer_id, p_start_at, p_end_at,
    'pending_payment', v_total_price, p_discount_amount, p_notes, p_booking_series_id, auth.uid()
  ) returning id into v_booking_id;

  -- Create the invoice (always -- a booking always has a financial record).
  v_invoice_number := public.issue_invoice_number(v_branch_id, v_club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch_id, v_invoice_number, p_customer_id, 'issued', v_total_price, p_discount_amount, v_total_price - p_discount_amount, now(), auth.uid())
  returning id into v_invoice_id;

  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'حجز ' || v_field.name, 'booking', v_booking_id, v_hours, v_price_per_hour, v_total_price - p_discount_amount);

  update public.bookings set invoice_id = v_invoice_id where id = v_booking_id;

  -- Optional payment, allocated to the invoice just created.
  if p_record_payment and p_payment_amount is not null and p_payment_amount > 0 then
    if not public.has_permission('payment.create', v_club_id) then
      raise exception 'not authorized to record a payment';
    end if;

    insert into public.payments (club_id, branch_id, customer_id, method, amount, received_by)
    values (v_club_id, v_branch_id, p_customer_id, coalesce(p_payment_method, 'cash'), p_payment_amount, auth.uid())
    returning id into v_payment_id;

    insert into public.payment_allocations (payment_id, invoice_id, amount)
    values (v_payment_id, v_invoice_id, least(p_payment_amount, v_total_price - p_discount_amount));

    update public.bookings set status = 'confirmed' where id = v_booking_id;
  end if;

  return v_booking_id;
end;
$$;

revoke execute on function public.create_booking(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric, uuid) from public;
revoke execute on function public.create_booking(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric, uuid) from anon;
grant execute on function public.create_booking(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric, uuid) to authenticated;

-- ============================================================
-- create_recurring_booking: checks ALL requested occurrences against the
-- exclusion constraint, creates N real bookings (each independently going
-- through the same create_booking-equivalent checks), never bypasses
-- per-booking validation. Weekly-only pattern for V1 (day_of_week +
-- start/end time, N occurrences) -- the simplest pattern that satisfies
-- the documented "8 weeks every Tuesday" example.
-- ============================================================
create or replace function public.create_recurring_booking(
  p_field_id uuid,
  p_customer_id uuid,
  p_first_start_at timestamptz,
  p_first_end_at timestamptz,
  p_occurrence_count int,
  p_interval_days int default 7
)
returns table(series_id uuid, requested int, created int, conflicted_occurrences timestamptz[])
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_series_id uuid;
  v_occurrence_start timestamptz;
  v_occurrence_end timestamptz;
  v_created_count int := 0;
  v_conflicts timestamptz[] := array[]::timestamptz[];
  i int;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id into v_club_id from public.fields where id = p_field_id;
  if v_club_id is null then
    raise exception 'field not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('booking.create', v_club_id)) then
    raise exception 'not authorized';
  end if;

  if not public.club_write_allowed(v_club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new bookings';
  end if;

  if p_occurrence_count < 1 or p_occurrence_count > 52 then
    raise exception 'occurrence count must be between 1 and 52';
  end if;

  insert into public.booking_series (club_id, field_id, customer_id, pattern_description, requested_occurrences, created_by)
  values (
    v_club_id, p_field_id, p_customer_id,
    p_occurrence_count || ' occurrences starting ' || p_first_start_at::date,
    p_occurrence_count, auth.uid()
  ) returning id into v_series_id;

  for i in 0..(p_occurrence_count - 1) loop
    v_occurrence_start := p_first_start_at + (i * p_interval_days || ' days')::interval;
    v_occurrence_end := p_first_end_at + (i * p_interval_days || ' days')::interval;

    begin
      -- Each occurrence goes through the exact same create_booking path --
      -- never a shortcut around per-booking conflict checking (ADR-047).
      -- booking_series_id is passed directly, not inferred after the fact,
      -- so a concurrent second recurring-booking call by the same user
      -- cannot misattribute occurrences between series.
      perform public.create_booking(
        p_field_id, p_customer_id, v_occurrence_start, v_occurrence_end,
        p_booking_series_id => v_series_id
      );
      v_created_count := v_created_count + 1;
    exception when exclusion_violation then
      v_conflicts := v_conflicts || v_occurrence_start;
    end;
  end loop;

  update public.booking_series set created_occurrences = v_created_count where id = v_series_id;

  return query select v_series_id, p_occurrence_count, v_created_count, v_conflicts;
end;
$$;

revoke execute on function public.create_recurring_booking(uuid, uuid, timestamptz, timestamptz, int, int) from public;
revoke execute on function public.create_recurring_booking(uuid, uuid, timestamptz, timestamptz, int, int) from anon;
grant execute on function public.create_recurring_booking(uuid, uuid, timestamptz, timestamptz, int, int) to authenticated;

-- ============================================================
-- create_field_block: checks for conflicting existing bookings, never
-- auto-cancels -- surfaces conflicts for an explicit decision.
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

  -- Block is created regardless of conflicts -- it never auto-cancels an
  -- existing booking. Conflicts are returned for the caller to decide.
  insert into public.field_blocks (club_id, field_id, start_at, end_at, reason, type, created_by)
  values (v_club_id, p_field_id, p_start_at, p_end_at, p_reason, p_type, auth.uid())
  returning id into v_block_id;

  return query select v_block_id, coalesce(v_conflicts, array[]::uuid[]);
end;
$$;

revoke execute on function public.create_field_block(uuid, timestamptz, timestamptz, text, text) from public;
revoke execute on function public.create_field_block(uuid, timestamptz, timestamptz, text, text) from anon;
grant execute on function public.create_field_block(uuid, timestamptz, timestamptz, text, text) to authenticated;

-- ============================================================
-- cancel_booking / mark_no_show
-- ============================================================
create or replace function public.cancel_booking(p_booking_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a cancellation reason is required';
  end if;

  select club_id into v_club_id from public.bookings where id = p_booking_id;
  if v_club_id is null then
    raise exception 'booking not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('booking.cancel', v_club_id)) then
    raise exception 'not authorized';
  end if;

  update public.bookings
  set status = 'cancelled', cancelled_reason = p_reason, cancelled_by = auth.uid(), cancelled_at = now()
  where id = p_booking_id and status in ('pending_payment', 'confirmed');

  if not found then
    raise exception 'booking not found or not in a cancellable state';
  end if;

  perform public.write_audit_log(v_club_id, 'cancel_booking', 'bookings', p_booking_id, null, jsonb_build_object('status', 'cancelled'), p_reason);
end;
$$;

revoke execute on function public.cancel_booking(uuid, text) from public;
revoke execute on function public.cancel_booking(uuid, text) from anon;
grant execute on function public.cancel_booking(uuid, text) to authenticated;

create or replace function public.mark_booking_no_show(p_booking_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
begin
  select club_id into v_club_id from public.bookings where id = p_booking_id;
  if v_club_id is null then
    raise exception 'booking not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('booking.update', v_club_id)) then
    raise exception 'not authorized';
  end if;

  update public.bookings
  set status = 'no_show', marked_by = auth.uid(), marked_at = now(), notes = coalesce(notes || E'\n', '') || coalesce(p_reason, '')
  where id = p_booking_id and status in ('confirmed', 'checked_in');

  if not found then
    raise exception 'booking not found or not in a markable state';
  end if;
end;
$$;

revoke execute on function public.mark_booking_no_show(uuid, text) from public;
revoke execute on function public.mark_booking_no_show(uuid, text) from anon;
grant execute on function public.mark_booking_no_show(uuid, text) to authenticated;

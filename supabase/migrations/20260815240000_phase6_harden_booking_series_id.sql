-- Phase 6 hardening — remove p_booking_series_id from the public
-- create_booking surface entirely (Option A). A client must not be able
-- to attach a booking to an arbitrary booking_series it doesn't control:
-- the previous same-club-only check let any caller with booking.create in
-- a club attach their booking to ANY other series in that same club
-- (different customer, different field, someone else's series) -- that's
-- bookkeeping corruption, not a privilege escalation in the strict sense,
-- but it's still an unvalidated trust boundary that must not exist.
--
-- Fix: split into a private, non-grantable _create_booking_internal
-- (accepts p_booking_series_id, never exposed to authenticated directly)
-- and a public create_booking with no series parameter at all. Only
-- create_recurring_booking -- which creates the series row itself in the
-- same transaction and passes back its own freshly-generated id -- can
-- ever supply a non-null series id.

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

  -- p_booking_series_id is never client-reachable (this function has no
  -- EXECUTE grant to authenticated) -- but even so, defense in depth:
  -- the series must belong to the same club AND reference the exact same
  -- field and customer being booked right now, not merely "some series in
  -- this club". This closes the bookkeeping-corruption path even if this
  -- function's access were ever accidentally widened later.
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

-- Deliberately NOT granted to authenticated/anon -- only callable from
-- other SECURITY DEFINER function bodies (create_booking,
-- create_recurring_booking), kept out of PostgREST's directly-callable
-- RPC surface entirely, same pattern as write_audit_log/issue_invoice_number.
revoke execute on function public._create_booking_internal(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric, uuid) from public;
revoke execute on function public._create_booking_internal(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric, uuid) from anon;
revoke execute on function public._create_booking_internal(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric, uuid) from authenticated;

-- ============================================================
-- create_booking: public surface, no p_booking_series_id parameter at
-- all -- a standalone booking created through this path can never be
-- attached to any series, by construction, not just by validation.
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
  p_payment_amount numeric default null
)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  select public._create_booking_internal(
    p_field_id, p_customer_id, p_start_at, p_end_at,
    p_discount_amount, p_notes, p_record_payment, p_payment_method, p_payment_amount,
    null
  );
$$;

-- Drop the old 10-arg signature (with p_booking_series_id) that this
-- migration replaces -- it must not remain callable alongside the new one.
drop function if exists public.create_booking(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric, uuid);

revoke execute on function public.create_booking(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric) from public;
revoke execute on function public.create_booking(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric) from anon;
grant execute on function public.create_booking(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric) to authenticated;

-- ============================================================
-- create_recurring_booking: now calls _create_booking_internal directly
-- (not the public create_booking wrapper), since it's the one legitimate
-- caller allowed to supply a series id -- and only its own, freshly
-- created in the same transaction.
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
      -- Each occurrence goes through the exact same validation path as a
      -- standalone booking -- never a shortcut around per-booking
      -- conflict checking (ADR-047). v_series_id was just created in
      -- THIS transaction, for THIS field/customer -- not client-supplied.
      perform public._create_booking_internal(
        p_field_id, p_customer_id, v_occurrence_start, v_occurrence_end,
        0, null, false, null, null, v_series_id
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

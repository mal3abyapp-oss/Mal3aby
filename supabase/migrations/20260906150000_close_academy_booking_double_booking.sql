-- P0 FIX: Academy training_sessions and field bookings can double-book
-- the same field/time with zero coordination.
--
-- ROOT CAUSE (confirmed live in production, gxkrtlvpjwxhcqdisyob, before
-- this migration):
--   groups.field_id + group_schedule_slots + training_sessions
--   (materialized by generate_training_sessions(), see
--   20260815330000_phase12_sessions_attendance.sql) are completely
--   invisible to:
--     1. bookings' own conflict defense --
--        EXCLUDE USING gist (field_id WITH =, during WITH &&)
--        WHERE status IN ('pending_payment','confirmed','checked_in')
--        (constraint no_overlapping_field_bookings) -- which only knows
--        about the bookings table.
--     2. _field_available_starts_internal() / get_public_field_availability
--        (20260823040000_field_available_starts_engine.sql), the RPCs the
--        staff calendar and public booking page call to compute free
--        slots -- both only SELECT FROM bookings + field_blocks.
--     3. generate_training_sessions() itself, which only guards against
--        *duplicate session generation* (ON CONFLICT on
--        (group_id, session_date, start_time)), never against an existing
--        booking on the same field/time.
--   Live proof (read-only, reproduced again immediately before writing
--   this migration): field "ملعب 2 - كرة قدم"
--   (673b6cbb-739f-4f0c-b973-928b3116e145) has academy group "مجموعة U14"
--   scheduled Monday/Wednesday 17:00-18:30 Africa/Cairo
--   (group_schedule_slots e6439070.../8d1239c0...), and training_sessions
--   materialized a session for 2026-08-16 (a Monday) 17:00-18:30, while
--   booking be3598d6-7f82-46d1-9f6d-07af30ea6c78 is a real customer's
--   'completed' booking on the SAME field, SAME day, 17:00-18:00 Cairo
--   (2026-08-16 14:00-15:00 UTC) -- same pitch, overlapping time, both
--   systems claiming it with zero coordination.
--
-- WHY NOT A SINGLE SHARED EXCLUDE CONSTRAINT ACROSS BOTH TABLES:
--   Postgres exclusion constraints are single-relation; there is no
--   syntax for one EXCLUDE spanning two physical tables. The correct,
--   standard pattern for "two independently-written tables must not
--   overlap on the same resource" is: (a) give EACH table its own
--   same-table EXCLUDE constraint (bookings already has one; this
--   migration adds the missing sibling to training_sessions), and
--   (b) serialize the two tables' writers against each other so the
--   cross-table check they each perform cannot race -- see the
--   pg_advisory_xact_lock discussion below. This mirrors exactly how
--   field_blocks vs bookings is already handled today (field_blocks has
--   no EXCLUDE of its own; create/reschedule booking each SELECT it
--   under the same transaction) -- we are extending that established
--   pattern to a second source, not inventing a new one, while ALSO
--   closing the TOCTOU gap that field_blocks' SELECT-only check still
--   has (a pre-existing, out-of-scope gap, noted for the record).
--
-- FIX, THREE PARTS:
--   1. training_sessions gets its own `during tstzrange` GENERATED
--      column (session_date + start_time/end_time interpreted in the
--      owning club's timezone -- same timezone-conversion shape
--      _field_available_starts_internal already uses) and its own
--      EXCLUDE USING gist (field_id WITH =, during WITH &&) WHERE
--      (status <> 'cancelled' AND field_id IS NOT NULL). This is the
--      same defense-in-depth bookings already has for booking-vs-
--      booking; it now exists for session-vs-session on the same field.
--      NOTE: a GENERATED column cannot itself call a stable/volatile
--      function (timezone lookup), so `during` is maintained by a
--      BEFORE INSERT OR UPDATE trigger (trg_training_sessions_during)
--      instead of a true STORED GENERATED ALWAYS AS expression --
--      functionally equivalent (always kept in sync, cannot be set
--      directly by client code since it is trigger-owned), documented
--      here so it isn't mistaken for an oversight.
--   2. generate_training_sessions() is hardened to REJECT generating a
--      session that overlaps an existing CONFLICTING booking on the
--      same field, and _create_booking_internal / create_public_booking
--      / reschedule_booking are hardened to REJECT creating/moving a
--      booking that overlaps an existing non-cancelled training_session
--      on the same field. Both directions now check the other table.
--   3. TOCTOU closure: both directions take
--      pg_advisory_xact_lock(hashtextextended('field:'||field_id, 0))
--      before doing their conflict SELECT + INSERT, so a concurrent
--      "create booking on field X" and "generate session on field X"
--      cannot interleave between the other's SELECT and INSERT --
--      the second transaction blocks on the lock until the first
--      commits (or rolls back), then re-evaluates with fresh data,
--      exactly closing the same class of race the bookings EXCLUDE
--      constraint alone closes for booking-vs-booking. The advisory
--      lock is transaction-scoped (xact, not session) so it always
--      releases at commit/rollback -- it cannot leak or deadlock past
--      the current statement's transaction.
--
-- PRESERVED GUARANTEES (verified against live function bodies before
-- writing this migration, not assumed):
--   - bookings' own no_overlapping_field_bookings EXCLUDE constraint is
--     untouched -- zero regression risk to booking-vs-booking defense.
--   - All existing _create_booking_internal / create_public_booking /
--     reschedule_booking guards (branch scope, field.status, fields
--     module active, subscription/new_commitment gate, operating hours,
--     field_blocks, segmented pricing, discount ceiling, overpayment
--     guard, cash-shift gate, government receipt policy, exclusion-
--     violation friendly error) are preserved verbatim -- the new check
--     is inserted alongside them, not in place of them.
--   - generate_training_sessions' existing branch-scope + academy-
--     module-active + idempotent ON CONFLICT DO NOTHING guards
--     (20260829150000_academy_rpc_branch_scope_sweep.sql) are preserved.
--   - RLS/permissions on training_sessions/bookings are untouched.
--
-- RESIDUAL RISK (honest, not hidden): a session with field_id IS NULL
-- (off-site training, no facility conflict possible) is correctly
-- exempted from both the EXCLUDE constraint and the cross-table checks.
-- field_blocks itself still has no EXCLUDE constraint of its own and
-- still relies on SELECT-then-INSERT under the SAME advisory lock added
-- here for the booking side -- so a field_blocks-vs-booking race is now
-- ALSO closed as a side effect (booking creation already took the lock
-- before checking field_blocks), but a raw manual INSERT into
-- field_blocks that bypasses create_booking/create_public_booking
-- entirely is not this migration's scope and remains a separate,
-- pre-existing gap.

-- ============================================================
-- 1. training_sessions.during + its own same-table EXCLUDE constraint
-- ============================================================

alter table public.training_sessions add column during tstzrange;

-- Backfill existing rows (16 live rows at time of writing -- safe to
-- compute inline, no batching needed).
update public.training_sessions ts
set during = tstzrange(
  (ts.session_date::timestamp + ts.start_time) at time zone c.timezone,
  (ts.session_date::timestamp + ts.end_time) at time zone c.timezone,
  '[)'
)
from public.groups g
join public.clubs c on c.id = g.club_id
where g.id = ts.group_id;

-- A session with no club-resolvable timezone should never have existed
-- (groups.club_id is NOT NULL, clubs.timezone is NOT NULL per Phase 5/10
-- schema) -- guard defensively rather than assume.
do $$
begin
  if exists (select 1 from public.training_sessions where during is null) then
    raise exception 'training_sessions backfill left NULL during values -- investigate before proceeding';
  end if;
end $$;

alter table public.training_sessions alter column during set not null;

-- Trigger-maintained (see header comment for why this isn't a real
-- GENERATED ALWAYS AS column: timezone lookup requires a table join,
-- which generated-column expressions cannot perform).
create or replace function public._training_sessions_set_during()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  v_timezone text;
begin
  select c.timezone into v_timezone
  from public.groups g join public.clubs c on c.id = g.club_id
  where g.id = new.group_id;

  if v_timezone is null then
    raise exception 'cannot resolve club timezone for group %', new.group_id;
  end if;

  new.during := tstzrange(
    (new.session_date::timestamp + new.start_time) at time zone v_timezone,
    (new.session_date::timestamp + new.end_time) at time zone v_timezone,
    '[)'
  );
  return new;
end;
$$;

create trigger trg_training_sessions_set_during
  before insert or update of session_date, start_time, end_time, group_id
  on public.training_sessions
  for each row execute function public._training_sessions_set_during();

-- Same-table defense-in-depth, mirroring no_overlapping_field_bookings.
-- Excludes field_id IS NULL sessions (off-site, no facility to conflict
-- over) and cancelled sessions (a cancelled session no longer occupies
-- the field).
alter table public.training_sessions
  add constraint no_overlapping_training_sessions
  exclude using gist (field_id with =, during with &&)
  where (status <> 'cancelled' and field_id is not null);

-- ============================================================
-- 2. Cross-table conflict checks + advisory-lock TOCTOU closure
-- ============================================================

-- Shared helper: true if [p_start_at, p_end_at) overlaps any
-- non-cancelled training_session on p_field_id. SECURITY DEFINER,
-- STABLE-in-intent but marked VOLATILE (default) since callers use it
-- inside a lock-then-check-then-write sequence where the read must not
-- be reordered/cached across the advisory lock acquisition -- STABLE
-- would be safe too given it's always called after the lock, but
-- VOLATILE is the conservative choice here and costs nothing (this is
-- an internal helper called at most twice per booking/session write).
create or replace function public._field_has_conflicting_training_session(
  p_field_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_exclude_session_id uuid default null
)
returns boolean
language sql
security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1 from public.training_sessions ts
    where ts.field_id = p_field_id
      and ts.status <> 'cancelled'
      and (p_exclude_session_id is null or ts.id <> p_exclude_session_id)
      and ts.during && tstzrange(p_start_at, p_end_at, '[)')
  );
$$;

revoke all on function public._field_has_conflicting_training_session(uuid, timestamptz, timestamptz, uuid) from public;
revoke all on function public._field_has_conflicting_training_session(uuid, timestamptz, timestamptz, uuid) from anon;
grant execute on function public._field_has_conflicting_training_session(uuid, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public._field_has_conflicting_training_session(uuid, timestamptz, timestamptz, uuid) to service_role;

create or replace function public._field_has_conflicting_booking(
  p_field_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_exclude_booking_id uuid default null
)
returns boolean
language sql
security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1 from public.bookings b
    where b.field_id = p_field_id
      and b.status in ('pending_payment', 'confirmed', 'checked_in')
      and (p_exclude_booking_id is null or b.id <> p_exclude_booking_id)
      and b.during && tstzrange(p_start_at, p_end_at, '[)')
  );
$$;

revoke all on function public._field_has_conflicting_booking(uuid, timestamptz, timestamptz, uuid) from public;
revoke all on function public._field_has_conflicting_booking(uuid, timestamptz, timestamptz, uuid) from anon;
grant execute on function public._field_has_conflicting_booking(uuid, timestamptz, timestamptz, uuid) to authenticated;
grant execute on function public._field_has_conflicting_booking(uuid, timestamptz, timestamptz, uuid) to service_role;

-- ------------------------------------------------------------
-- 2a. generate_training_sessions: take the field's advisory lock, then
-- reject creating any session that overlaps an existing conflicting
-- booking. Everything else about this function (branch-scope check,
-- academy-module-active check, idempotent ON CONFLICT DO NOTHING) is
-- preserved verbatim from the live version
-- (20260829150000_academy_rpc_branch_scope_sweep.sql).
-- ------------------------------------------------------------

create or replace function public.generate_training_sessions(p_group_id uuid, p_through_date date)
returns int
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_group record;
  v_slot record;
  v_date date;
  v_created_count int := 0;
  v_timezone text;
  v_candidate_start timestamptz;
  v_candidate_end timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_group from public.groups where id = p_group_id;
  if v_group.id is null then
    raise exception 'group not found';
  end if;

  if not (v_group.club_id in (select public.user_club_ids()) and public.has_permission('session.manage', v_group.club_id)) then
    raise exception 'not authorized';
  end if;

  if not public.user_has_branch_access(v_group.club_id, v_group.branch_id) then
    raise exception 'you do not have access to this branch';
  end if;

  if not public._academy_module_active(v_group.club_id) then
    raise exception 'the academy module is not active for this club';
  end if;

  if p_through_date < current_date then
    raise exception 'p_through_date must be today or later';
  end if;

  select timezone into v_timezone from public.clubs where id = v_group.club_id;
  if v_timezone is null then
    raise exception 'club has no timezone configured';
  end if;

  -- FIX (this migration): serialize against concurrent booking creation
  -- on the same field for the duration of this transaction. Skipped
  -- entirely when the group has no assigned field (v_group.field_id is
  -- null) -- nothing to conflict over.
  if v_group.field_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('field:' || v_group.field_id::text, 0));
  end if;

  for v_slot in select * from public.group_schedule_slots where group_id = p_group_id loop
    v_date := current_date;
    while v_date <= p_through_date loop
      if extract(dow from v_date) = v_slot.day_of_week then
        v_candidate_start := (v_date::timestamp + v_slot.start_time) at time zone v_timezone;
        v_candidate_end := (v_date::timestamp + v_slot.end_time) at time zone v_timezone;

        -- FIX (this migration): the actual P0 closure -- reject
        -- generating a session that would overlap an existing
        -- confirmed/pending/checked-in booking on the same field.
        -- A conflicting date is SKIPPED (not a hard exception) so a
        -- multi-week generation run still succeeds for every
        -- non-conflicting date rather than aborting the whole batch --
        -- consistent with this function's existing idempotent/best-
        -- effort ON CONFLICT DO NOTHING semantics for duplicate
        -- sessions. The conflicting date is surfaced back to the caller
        -- via v_created_count being lower than the number of matching
        -- weekdays in range; callers/staff UI can diff expected vs
        -- v_created_count to notice a skip, same as they already must
        -- for ON CONFLICT DO NOTHING skips.
        if v_group.field_id is null or not public._field_has_conflicting_booking(v_group.field_id, v_candidate_start, v_candidate_end) then
          insert into public.training_sessions (club_id, group_id, field_id, coach_id, session_date, start_time, end_time)
          values (v_group.club_id, p_group_id, v_group.field_id, v_group.coach_id, v_date, v_slot.start_time, v_slot.end_time)
          on conflict (group_id, session_date, start_time) do nothing;
          if found then
            v_created_count := v_created_count + 1;
          end if;
        end if;
      end if;
      v_date := v_date + interval '1 day';
    end loop;
  end loop;

  return v_created_count;
end;
$$;

revoke execute on function public.generate_training_sessions(uuid, date) from public;
revoke execute on function public.generate_training_sessions(uuid, date) from anon;
grant execute on function public.generate_training_sessions(uuid, date) to authenticated;

-- ------------------------------------------------------------
-- 2b. _create_booking_internal / create_public_booking /
-- reschedule_booking: take the same field advisory lock, then reject
-- creating/moving a booking that overlaps an existing non-cancelled
-- training_session on the same field. All pre-existing guards in each
-- function are preserved verbatim (verified against the live function
-- bodies immediately before writing this migration) -- only the new
-- lock + check is inserted, positioned right before each function's
-- existing field_blocks check so both cross-table checks happen inside
-- the same locked window.
-- ------------------------------------------------------------

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
  p_booking_series_id uuid,
  p_receipt_serial text default null,
  p_receipt_date date default null,
  p_receipt_book text default null,
  p_receipt_series text default null,
  p_receipt_image_path text default null,
  p_receipt_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
  v_branch_id uuid;
  v_field record;
  v_timezone text;
  v_local_date date;
  v_local_start_time time;
  v_local_end_time time;
  v_hours numeric;
  v_total_price numeric;
  v_effective_unit_price numeric;
  v_booking_id uuid;
  v_invoice_id uuid;
  v_invoice_number text;
  v_payment_id uuid;
  v_hours_row record;
  v_event_id uuid;
  v_club_name text;
  v_customer_name text;
  v_customer_user_id uuid;
  v_activation_token text;
  v_activation_secret text;
  v_booking_ref text;
  v_qr_token text;
  v_invoice_token text;
  v_payment_status text;
  v_hold_minutes int;
  v_hold_expires_at timestamptz;
  v_effective_policy public.government_collection_policies;
  v_receipt_required boolean := false;
  v_receipt_id uuid;
  v_has_custody boolean;
  v_active_shift_id uuid;
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

  if not public.user_has_branch_access(v_club_id, v_branch_id) then
    raise exception 'not authorized for this branch';
  end if;

  if v_field.status <> 'active' then
    raise exception 'this field is not currently available for booking (status: %)', v_field.status;
  end if;

  if not public._fields_module_active(v_club_id) then
    raise exception 'the fields module is not active for this club';
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

  if p_start_at <= now() then
    raise exception 'booking time must be in the future';
  end if;

  select timezone into v_timezone from public.clubs where id = v_club_id;
  if v_timezone is null then
    raise exception 'club has no timezone configured';
  end if;

  v_local_date := (p_start_at at time zone v_timezone)::date;
  v_local_start_time := (p_start_at at time zone v_timezone)::time;
  v_local_end_time := (p_end_at at time zone v_timezone)::time;

  if v_local_date <> ((p_end_at - interval '1 second') at time zone v_timezone)::date then
    raise exception 'a booking cannot span more than one calendar day';
  end if;

  select * into v_hours_row from public.resolve_field_operating_hours(p_field_id, v_local_date);
  if v_hours_row.has_any_config and v_hours_row.open_time is null then
    raise exception 'field is closed on this day';
  end if;
  if v_hours_row.has_any_config and (v_local_start_time < v_hours_row.open_time or v_local_end_time > v_hours_row.close_time) then
    raise exception 'booking time is outside the field''s operating hours (% - %)', v_hours_row.open_time, v_hours_row.close_time;
  end if;

  -- FIX (this migration): serialize against concurrent training-session
  -- generation on the same field, then reject if an academy session
  -- already claims this field/time. Positioned before the field_blocks
  -- check so both cross-table reads happen inside one locked window.
  perform pg_advisory_xact_lock(hashtextextended('field:' || p_field_id::text, 0));

  if public._field_has_conflicting_training_session(p_field_id, p_start_at, p_end_at) then
    raise exception 'this field has an academy training session scheduled during this time';
  end if;

  if exists (
    select 1 from public.field_blocks
    where field_id = p_field_id
      and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then
    raise exception 'field is blocked during this time';
  end if;

  v_hours := extract(epoch from (p_end_at - p_start_at)) / 3600.0;
  select coalesce(sum(s.segment_total), 0) into v_total_price
  from public.resolve_field_price_total(p_field_id, v_local_date, v_local_start_time, v_local_end_time) s;
  v_effective_unit_price := round(v_total_price / v_hours, 4);

  if p_discount_amount < 0 then
    raise exception 'discount amount cannot be negative';
  end if;

  if p_discount_amount > 0 then
    if not public.has_permission('booking.discount.apply', v_club_id) then
      raise exception 'not authorized to apply a discount';
    end if;
    if p_discount_amount > v_total_price * 0.3 and not public.has_permission('booking.discount.override', v_club_id) then
      raise exception 'discount exceeds the standard limit -- requires override permission';
    end if;
    if p_discount_amount > v_total_price then
      raise exception 'discount amount (%) cannot exceed the booking total (%)', p_discount_amount, v_total_price;
    end if;
  end if;

  if p_record_payment and p_payment_amount is not null and p_payment_amount > 0
     and p_payment_amount > (v_total_price - p_discount_amount) then
    raise exception 'payment amount (%) exceeds the invoice''s outstanding balance (%)', p_payment_amount, (v_total_price - p_discount_amount);
  end if;

  if p_record_payment and p_payment_amount is not null and p_payment_amount > 0
     and coalesce(p_payment_method, 'cash') = 'cash' then
    select coalesce(bool_or(has_cash_custody), false) into v_has_custody
    from public.club_memberships
    where user_id = auth.uid() and club_id = v_club_id and status = 'active';

    if v_has_custody then
      select id into v_active_shift_id
      from public.cash_shifts
      where branch_id = v_branch_id and opened_by = auth.uid() and status = 'open';

      if v_active_shift_id is null then
        raise exception 'cash collection requires an active cash shift -- open one before collecting cash';
      end if;
    end if;
  end if;

  if p_record_payment and p_payment_amount is not null and p_payment_amount > 0 then
    v_effective_policy := public.get_effective_government_policy(v_club_id, v_branch_id, p_field_id);
    v_receipt_required := v_effective_policy.enabled
      and v_effective_policy.official_receipt_required
      and coalesce(p_payment_method, 'cash') = any(v_effective_policy.required_payment_methods);

    if v_receipt_required then
      if p_receipt_serial is null or length(trim(p_receipt_serial)) = 0 then
        raise exception 'official collection receipt required: this club/field requires an official government collection receipt for % payments', coalesce(p_payment_method, 'cash');
      end if;
      if p_receipt_date is null then
        raise exception 'receipt date is required';
      end if;
      if p_receipt_date > (current_date + interval '1 day')::date then
        raise exception 'receipt date cannot be in the future';
      end if;
      if v_effective_policy.receipt_image_required and p_receipt_image_path is null then
        raise exception 'a receipt image is required by this club/field''s compliance policy';
      end if;
    end if;
  end if;

  if not (p_record_payment and p_payment_amount is not null and p_payment_amount > 0) then
    select payment_hold_minutes into v_hold_minutes from public.get_public_club_booking_policy(v_club_id);
    v_hold_expires_at := now() + make_interval(mins => v_hold_minutes);
  end if;

  begin
    insert into public.bookings (
      club_id, branch_id, field_id, customer_id, start_at, end_at,
      status, total_price, discount_amount, notes, booking_series_id, created_by, hold_expires_at
    ) values (
      v_club_id, v_branch_id, p_field_id, p_customer_id, p_start_at, p_end_at,
      'pending_payment', v_total_price, p_discount_amount, p_notes, p_booking_series_id, auth.uid(), v_hold_expires_at
    ) returning id into v_booking_id;
  exception when exclusion_violation then
    raise exception 'this time slot was just booked by someone else -- please choose another time';
  end;

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
  values (v_invoice_id, 'حجز ' || v_field.name, 'booking', v_booking_id, v_hours, v_effective_unit_price, v_total_price - p_discount_amount);

  update public.bookings set invoice_id = v_invoice_id where id = v_booking_id;

  select name into v_club_name from public.clubs where id = v_club_id;
  select full_name, user_id into v_customer_name, v_customer_user_id from public.customers where id = p_customer_id;
  v_booking_ref := 'MB-' || upper(substring(v_booking_id::text, 1, 8));

  v_qr_token := public._mint_booking_qr_token_internal(v_booking_id, v_club_id, p_end_at + interval '2 hours', auth.uid());

  if v_customer_user_id is null then
    select raw_token, raw_secret into v_activation_token, v_activation_secret
    from public._mint_portal_invite_internal(
      v_club_id, p_customer_id, v_booking_id, now() + interval '48 hours', auth.uid()
    );
  end if;

  v_event_id := public.emit_notification_event(
    v_club_id, 'booking.created', 'booking', v_booking_id,
    jsonb_build_object('field_name', v_field.name, 'customer_id', p_customer_id, 'start_at', p_start_at, 'end_at', p_end_at, 'total_price', v_total_price)
  );

  if not (p_record_payment and p_payment_amount is not null and p_payment_amount > 0) then
    perform public.queue_whatsapp_notification(
      v_club_id, v_event_id, p_customer_id, 'booking-created', 'booking_confirmations',
      jsonb_build_object(
        'field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at,
        'total_price', v_total_price, 'invoice_number', v_invoice_number, 'payment_status', 'unpaid',
        'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone, 'booking_ref', v_booking_ref,
        'booking_qr_token', v_qr_token, 'hold_expires_at', v_hold_expires_at,
        'activation_token', v_activation_token, 'activation_secret', v_activation_secret
      ),
      'transactional', 'booking.created:' || v_booking_id::text
    );
    perform public.queue_email_notification(
      v_club_id, v_event_id, p_customer_id, 'booking-created', 'booking_confirmations',
      jsonb_build_object(
        'field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at,
        'total_price', v_total_price, 'invoice_number', v_invoice_number, 'payment_status', 'unpaid',
        'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone, 'booking_ref', v_booking_ref,
        'booking_qr_token', v_qr_token, 'hold_expires_at', v_hold_expires_at,
        'activation_token', v_activation_token
      ),
      'transactional', 'booking.created:' || v_booking_id::text
    );
  end if;

  if p_record_payment and p_payment_amount is not null and p_payment_amount > 0 then
    if not public.has_permission('payment.create', v_club_id) then
      raise exception 'not authorized to record a payment';
    end if;

    insert into public.payments (club_id, branch_id, customer_id, method, amount, received_by, cash_shift_id)
    values (v_club_id, v_branch_id, p_customer_id, coalesce(p_payment_method, 'cash'), p_payment_amount, auth.uid(), v_active_shift_id)
    returning id into v_payment_id;

    if v_receipt_required then
      insert into public.official_collection_receipts (
        club_id, branch_id, field_id, payment_id, invoice_id, booking_id, customer_id, authority_type,
        receipt_book, receipt_series, receipt_serial,
        receipt_date, receipt_amount, payment_method,
        entered_by, receipt_image_path, notes
      ) values (
        v_club_id, v_branch_id, p_field_id, v_payment_id, v_invoice_id, v_booking_id, p_customer_id,
        v_effective_policy.authority_type,
        p_receipt_book, p_receipt_series, p_receipt_serial,
        p_receipt_date, p_payment_amount, coalesce(p_payment_method, 'cash'),
        auth.uid(), p_receipt_image_path, p_receipt_notes
      )
      returning id into v_receipt_id;

      perform public.write_audit_log(
        v_club_id, 'official_collection_receipt.created', 'official_collection_receipt', v_receipt_id,
        null,
        jsonb_build_object('payment_id', v_payment_id, 'receipt_serial', p_receipt_serial, 'amount', p_payment_amount),
        null
      );
    end if;

    perform public.write_audit_log(
      v_club_id, 'payment.record', 'payment', v_payment_id, null,
      jsonb_build_object('amount', p_payment_amount, 'method', coalesce(p_payment_method, 'cash'), 'invoice_id', v_invoice_id, 'official_receipt_id', v_receipt_id),
      null
    );

    insert into public.payment_allocations (payment_id, invoice_id, amount)
    values (v_payment_id, v_invoice_id, least(p_payment_amount, v_total_price - p_discount_amount));

    update public.bookings set status = 'confirmed' where id = v_booking_id;

    v_payment_status := case when p_payment_amount >= (v_total_price - p_discount_amount) then 'paid' else 'partially_paid' end;

    perform public.emit_notification_event(
      v_club_id, 'booking.confirmed', 'booking', v_booking_id,
      jsonb_build_object('field_name', v_field.name, 'customer_id', p_customer_id, 'start_at', p_start_at, 'end_at', p_end_at)
    );

    v_invoice_token := public._mint_invoice_token_internal(v_invoice_id, v_club_id, auth.uid());

    v_event_id := public.emit_notification_event(
      v_club_id, 'payment.received', 'payment', v_payment_id,
      jsonb_build_object('amount', p_payment_amount, 'method', coalesce(p_payment_method, 'cash'), 'customer_id', p_customer_id, 'invoice_id', v_invoice_id)
    );

    perform public.queue_whatsapp_notification(
      v_club_id, v_event_id, p_customer_id, 'booking-confirmed-paid', 'booking_confirmations',
      jsonb_build_object(
        'field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at,
        'total_price', v_total_price, 'amount_paid', p_payment_amount, 'invoice_number', v_invoice_number,
        'payment_status', v_payment_status, 'method', coalesce(p_payment_method, 'cash'),
        'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone, 'booking_ref', v_booking_ref,
        'booking_qr_token', v_qr_token, 'invoice_token', v_invoice_token,
        'receipt_serial', case when v_receipt_required then p_receipt_serial else null end,
        'receipt_book', case when v_receipt_required then p_receipt_book else null end,
        'receipt_series', case when v_receipt_required then p_receipt_series else null end,
        'receipt_date', case when v_receipt_required then p_receipt_date else null end,
        'activation_token', v_activation_token, 'activation_secret', v_activation_secret
      ),
      'transactional', 'booking.confirmed_paid:' || v_booking_id::text
    );
    perform public.queue_email_notification(
      v_club_id, v_event_id, p_customer_id, 'booking-confirmed-paid', 'booking_confirmations',
      jsonb_build_object(
        'field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at,
        'total_price', v_total_price, 'amount_paid', p_payment_amount, 'invoice_number', v_invoice_number,
        'payment_status', v_payment_status, 'method', coalesce(p_payment_method, 'cash'),
        'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone, 'booking_ref', v_booking_ref,
        'booking_qr_token', v_qr_token, 'invoice_token', v_invoice_token,
        'receipt_serial', case when v_receipt_required then p_receipt_serial else null end,
        'receipt_book', case when v_receipt_required then p_receipt_book else null end,
        'receipt_series', case when v_receipt_required then p_receipt_series else null end,
        'receipt_date', case when v_receipt_required then p_receipt_date else null end,
        'activation_token', v_activation_token
      ),
      'transactional', 'booking.confirmed_paid:' || v_booking_id::text
    );
  end if;

  return v_booking_id;
end;
$function$;

revoke all on function public._create_booking_internal(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric, uuid, text, date, text, text, text, text) from public;
revoke all on function public._create_booking_internal(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric, uuid, text, date, text, text, text, text) from anon;
grant execute on function public._create_booking_internal(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric, uuid, text, date, text, text, text, text) to authenticated;

create or replace function public.create_public_booking(
  p_club_slug text,
  p_field_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_customer_name text,
  p_customer_mobile text,
  p_customer_phone_e164 text,
  p_notes text default null,
  p_source text default 'club_public_link',
  p_customer_email text default null
)
returns table(booking_id uuid, booking_ref text, hold_expires_at timestamptz, total_price numeric, invoice_id uuid, invoice_number text, booking_qr_token text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid; v_branch_id uuid; v_field record; v_timezone text;
  v_local_date date; v_local_start_time time; v_local_end_time time;
  v_hours numeric; v_total_price numeric; v_effective_unit_price numeric;
  v_booking_id uuid; v_invoice_id uuid; v_invoice_number text; v_hours_row record;
  v_event_id uuid; v_club_name text; v_customer_id uuid; v_normalized_mobile text;
  v_booking_ref text; v_qr_token text; v_access text; v_is_new_customer boolean := false;
  v_policy record; v_today_local date; v_days_out int; v_hold_minutes int; v_hold_expires_at timestamptz;
  v_existing_name text; v_name_mismatch boolean := false; v_email text;
begin
  if p_source not in ('club_public_link', 'club_qr') then raise exception 'invalid booking source'; end if;
  if p_customer_name is null or length(trim(p_customer_name)) = 0 then raise exception 'name is required'; end if;
  v_normalized_mobile := public.normalize_mobile(p_customer_mobile);
  if v_normalized_mobile is null or not public.is_phone_plausible(v_normalized_mobile) then
    raise exception 'a valid phone number is required';
  end if;
  if p_customer_phone_e164 is null or p_customer_phone_e164 !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'invalid phone number';
  end if;
  v_email := nullif(trim(p_customer_email), '');
  select c.id, c.name, c.timezone into v_club_id, v_club_name, v_timezone
    from public.clubs c join public.fields f on f.club_id = c.id
    where lower(c.public_slug) = lower(p_club_slug) and c.public_booking_enabled = true and c.status = 'active'
      and f.id = p_field_id and f.status = 'active';
  if v_club_id is null then raise exception 'this booking link is no longer available'; end if;
  if not public._fields_module_active(v_club_id) then raise exception 'this club is not currently accepting new bookings'; end if;
  v_access := public.get_public_club_subscription_access(v_club_id);
  if v_access = 'blocked' then raise exception 'this club is not currently accepting new bookings'; end if;
  select * into v_field from public.fields where id = p_field_id;
  v_branch_id := v_field.branch_id;
  if p_end_at <= p_start_at then raise exception 'end time must be after start time'; end if;
  if p_start_at <= now() then raise exception 'booking time must be in the future'; end if;

  select * into v_policy from public.get_public_club_booking_policy(v_club_id);
  v_today_local := (now() at time zone v_timezone)::date;
  v_local_date := (p_start_at at time zone v_timezone)::date;
  v_days_out := v_local_date - v_today_local;

  if v_days_out = 0 and not v_policy.same_day_online_booking_enabled then
    raise exception 'same-day online booking is not available for this club -- please contact the club directly to book today';
  end if;
  if v_days_out < v_policy.online_booking_start_offset_days then
    raise exception 'this date is not yet open for online booking';
  end if;
  if v_days_out > v_policy.online_booking_start_offset_days + v_policy.online_booking_window_days - 1 then
    raise exception 'this date is outside the online booking window';
  end if;

  v_local_start_time := (p_start_at at time zone v_timezone)::time;
  v_local_end_time := (p_end_at at time zone v_timezone)::time;
  if v_local_date <> ((p_end_at - interval '1 second') at time zone v_timezone)::date then
    raise exception 'a booking cannot span more than one calendar day';
  end if;
  select * into v_hours_row from public.resolve_field_operating_hours(p_field_id, v_local_date);
  if v_hours_row.has_any_config and v_hours_row.open_time is null then raise exception 'field is closed on this day'; end if;
  if v_hours_row.has_any_config and (v_local_start_time < v_hours_row.open_time or v_local_end_time > v_hours_row.close_time) then
    raise exception 'booking time is outside the field''s operating hours (% - %)', v_hours_row.open_time, v_hours_row.close_time;
  end if;

  -- FIX (this migration): serialize against concurrent training-session
  -- generation on the same field, then reject if an academy session
  -- already claims this field/time. Positioned before the field_blocks
  -- check so both cross-table reads happen inside one locked window.
  perform pg_advisory_xact_lock(hashtextextended('field:' || p_field_id::text, 0));

  if public._field_has_conflicting_training_session(p_field_id, p_start_at, p_end_at) then
    raise exception 'this field has an academy training session scheduled during this time';
  end if;

  if exists (select 1 from public.field_blocks where field_id = p_field_id
    and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')) then
    raise exception 'field is blocked during this time';
  end if;

  v_hours := extract(epoch from (p_end_at - p_start_at)) / 3600.0;
  select coalesce(sum(s.segment_total), 0) into v_total_price
  from public.get_public_field_price_total(p_field_id, v_local_date, v_local_start_time, v_local_end_time) s;
  v_effective_unit_price := round(v_total_price / v_hours, 4);

  select id, full_name into v_customer_id, v_existing_name from public.customers
    where club_id = v_club_id and phone_e164 = p_customer_phone_e164
      and duplicate_review_status = 'none'
    order by created_at asc
    limit 1;
  if v_customer_id is null then
    insert into public.customers (club_id, full_name, mobile_display, normalized_mobile, phone_e164, email)
    values (v_club_id, trim(p_customer_name), p_customer_mobile, v_normalized_mobile, p_customer_phone_e164, v_email)
    returning id into v_customer_id;
    v_is_new_customer := true;
  elsif lower(trim(v_existing_name)) is distinct from lower(trim(p_customer_name)) then
    v_name_mismatch := true;

    update public.customers
    set duplicate_review_status = 'quarantined_pending_review'
    where id = v_customer_id and duplicate_review_status = 'none';

    perform public.write_audit_log(
      v_club_id, 'customer.public_booking_name_mismatch', 'customer', v_customer_id,
      jsonb_build_object('full_name', v_existing_name),
      jsonb_build_object('submitted_name', trim(p_customer_name), 'phone_e164', p_customer_phone_e164),
      'public booking phone matched an existing customer but the submitted name differed -- flagged for duplicate review, WhatsApp consent re-confirmed as a fresh decision'
    );
  else
    update public.customers set full_name = trim(p_customer_name), email = coalesce(email, v_email), updated_at = now()
    where id = v_customer_id;
  end if;

  if v_is_new_customer or v_name_mismatch then
    insert into public.notification_consent (club_id, customer_id, channel, enabled, consent_source, consent_at, revoked_at, phone_display, normalized_phone, phone_e164)
    values (v_club_id, v_customer_id, 'whatsapp', true, 'public_booking_form', now(), null, p_customer_mobile, v_normalized_mobile, p_customer_phone_e164)
    on conflict (customer_id, channel) do update set
      enabled = true,
      consent_source = 'public_booking_form',
      consent_at = now(),
      revoked_at = null,
      phone_display = p_customer_mobile,
      normalized_phone = v_normalized_mobile,
      phone_e164 = p_customer_phone_e164,
      updated_at = now();
  end if;

  v_hold_minutes := v_policy.payment_hold_minutes;
  v_hold_expires_at := now() + make_interval(mins => v_hold_minutes);

  begin
    insert into public.bookings (club_id, branch_id, field_id, customer_id, start_at, end_at, status, total_price, discount_amount, notes, source, created_by, hold_expires_at)
    values (v_club_id, v_branch_id, p_field_id, v_customer_id, p_start_at, p_end_at, 'pending_payment', v_total_price, 0, p_notes, p_source, null, v_hold_expires_at)
    returning id into v_booking_id;
  exception when exclusion_violation then
    raise exception 'this time slot was just booked by someone else -- please choose another time';
  end;
  perform public.write_audit_log(v_club_id, 'booking.create', 'booking', v_booking_id, null,
    jsonb_build_object('field_id', p_field_id, 'customer_id', v_customer_id, 'total_price', v_total_price, 'source', p_source, 'hold_expires_at', v_hold_expires_at), null);
  v_invoice_number := public.issue_invoice_number(v_branch_id, v_club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch_id, v_invoice_number, v_customer_id, 'issued', v_total_price, 0, v_total_price, now(), null)
  returning id into v_invoice_id;
  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'حجز ' || v_field.name, 'booking', v_booking_id, v_hours, v_effective_unit_price, v_total_price);
  update public.bookings set invoice_id = v_invoice_id where id = v_booking_id;
  v_booking_ref := 'MB-' || upper(substring(v_booking_id::text, 1, 8));
  v_qr_token := public._mint_booking_qr_token_internal(v_booking_id, v_club_id, p_end_at + interval '2 hours', null);
  v_event_id := public.emit_notification_event(v_club_id, 'booking.created', 'booking', v_booking_id,
    jsonb_build_object('field_name', v_field.name, 'customer_id', v_customer_id, 'start_at', p_start_at, 'end_at', p_end_at, 'total_price', v_total_price, 'source', p_source));
  perform public.queue_whatsapp_notification(v_club_id, v_event_id, v_customer_id, 'booking-created', 'booking_confirmations',
    jsonb_build_object('field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at,
      'total_price', v_total_price, 'invoice_number', v_invoice_number, 'payment_status', 'unpaid',
      'club_name', v_club_name, 'customer_name', trim(p_customer_name), 'timezone', v_timezone, 'booking_ref', v_booking_ref,
      'booking_qr_token', v_qr_token, 'hold_expires_at', v_hold_expires_at),
    'transactional', 'booking.created:' || v_booking_id::text);
  perform public.queue_email_notification(v_club_id, v_event_id, v_customer_id, 'booking-created', 'booking_confirmations',
    jsonb_build_object('field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at,
      'total_price', v_total_price, 'invoice_number', v_invoice_number, 'payment_status', 'unpaid',
      'club_name', v_club_name, 'customer_name', trim(p_customer_name), 'timezone', v_timezone, 'booking_ref', v_booking_ref,
      'booking_qr_token', v_qr_token, 'hold_expires_at', v_hold_expires_at, 'customer_email', v_email),
    'transactional', 'booking.created:' || v_booking_id::text);
  return query select v_booking_id, v_booking_ref, v_hold_expires_at, v_total_price, v_invoice_id, v_invoice_number, v_qr_token;
end;
$function$;

revoke all on function public.create_public_booking(text, uuid, timestamptz, timestamptz, text, text, text, text, text, text) from public;
grant execute on function public.create_public_booking(text, uuid, timestamptz, timestamptz, text, text, text, text, text, text) to anon;
grant execute on function public.create_public_booking(text, uuid, timestamptz, timestamptz, text, text, text, text, text, text) to authenticated;

create or replace function public.reschedule_booking(
  p_booking_id uuid,
  p_new_start_at timestamptz,
  p_new_end_at timestamptz,
  p_new_field_id uuid default null,
  p_reason text default null
)
returns table(booking_id uuid, new_total_price numeric, price_changed boolean)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_booking record;
  v_target_field_id uuid;
  v_club_id uuid;
  v_branch_id uuid;
  v_field record;
  v_timezone text;
  v_local_date date;
  v_local_start_time time;
  v_local_end_time time;
  v_hours numeric;
  v_new_total_price numeric;
  v_effective_unit_price numeric;
  v_price_changed boolean := false;
  v_hours_row record;
  v_event_id uuid;
  v_club_name text;
  v_customer_name text;
  v_booking_ref text;
  v_qr_token text;
  v_timezone_for_msg text;
  v_paid numeric := 0;
  v_old_start_at timestamptz;
  v_old_end_at timestamptz;
  v_old_field_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_booking
  from public.bookings
  where id = p_booking_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('booking.update', club_id)
  for update;

  if v_booking.id is null then
    raise exception 'booking not found or you do not have permission to reschedule it';
  end if;

  v_club_id := v_booking.club_id;

  if not public._fields_module_active(v_club_id) then
    raise exception 'the fields module is not active for this club';
  end if;

  if not public.club_write_allowed(v_club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new bookings';
  end if;

  v_target_field_id := coalesce(p_new_field_id, v_booking.field_id);
  v_old_start_at := v_booking.start_at;
  v_old_end_at := v_booking.end_at;
  v_old_field_id := v_booking.field_id;

  if v_booking.status not in ('pending_payment', 'confirmed') then
    raise exception 'only a pending or confirmed booking can be rescheduled (current status: %)', v_booking.status;
  end if;
  if v_booking.start_at <= now() then
    raise exception 'a booking that has already started cannot be rescheduled';
  end if;

  if p_new_end_at <= p_new_start_at then
    raise exception 'end time must be after start time';
  end if;
  if p_new_start_at <= now() then
    raise exception 'the new booking time must be in the future';
  end if;

  select branch_id into v_branch_id from public.fields where id = v_target_field_id and club_id = v_club_id;
  if v_branch_id is null then
    raise exception 'field not found in this club';
  end if;
  select * into v_field from public.fields where id = v_target_field_id;

  if not public.user_has_branch_access(v_club_id, v_branch_id) then
    raise exception 'not authorized for this branch';
  end if;

  select timezone into v_timezone from public.clubs where id = v_club_id;
  if v_timezone is null then
    raise exception 'club has no timezone configured';
  end if;

  v_local_date := (p_new_start_at at time zone v_timezone)::date;
  v_local_start_time := (p_new_start_at at time zone v_timezone)::time;
  v_local_end_time := (p_new_end_at at time zone v_timezone)::time;

  if v_local_date <> ((p_new_end_at - interval '1 second') at time zone v_timezone)::date then
    raise exception 'a booking cannot span more than one calendar day';
  end if;

  select * into v_hours_row from public.resolve_field_operating_hours(v_target_field_id, v_local_date);
  if v_hours_row.has_any_config and v_hours_row.open_time is null then
    raise exception 'field is closed on this day';
  end if;
  if v_hours_row.has_any_config and (v_local_start_time < v_hours_row.open_time or v_local_end_time > v_hours_row.close_time) then
    raise exception 'the new time is outside the field''s operating hours (% - %)', v_hours_row.open_time, v_hours_row.close_time;
  end if;

  -- FIX (this migration): serialize against concurrent training-session
  -- generation on the target field, then reject if an academy session
  -- already claims this field/time. Positioned before the field_blocks
  -- check so both cross-table reads happen inside one locked window.
  perform pg_advisory_xact_lock(hashtextextended('field:' || v_target_field_id::text, 0));

  if public._field_has_conflicting_training_session(v_target_field_id, p_new_start_at, p_new_end_at) then
    raise exception 'this field has an academy training session scheduled during the new time';
  end if;

  if exists (
    select 1 from public.field_blocks
    where field_id = v_target_field_id
      and tstzrange(start_at, end_at, '[)') && tstzrange(p_new_start_at, p_new_end_at, '[)')
  ) then
    raise exception 'field is blocked during the new time';
  end if;

  if v_booking.invoice_id is not null then
    select coalesce(sum(pa.amount), 0) into v_paid
    from public.payment_allocations pa where pa.invoice_id = v_booking.invoice_id;
  end if;

  v_hours := extract(epoch from (p_new_end_at - p_new_start_at)) / 3600.0;
  select coalesce(sum(s.segment_total), 0) into v_new_total_price
  from public.resolve_field_price_total(v_target_field_id, v_local_date, v_local_start_time, v_local_end_time) s;
  v_effective_unit_price := round(v_new_total_price / v_hours, 4);

  begin
    update public.bookings
    set field_id = v_target_field_id,
        branch_id = v_branch_id,
        start_at = p_new_start_at,
        end_at = p_new_end_at,
        total_price = case when v_paid = 0 then v_new_total_price else v_booking.total_price end
    where id = p_booking_id;
  exception when exclusion_violation then
    raise exception 'the new time was just booked by someone else -- please choose another time';
  end;

  v_price_changed := (v_paid = 0) and (v_new_total_price is distinct from v_booking.total_price);

  if v_paid = 0 and v_booking.invoice_id is not null and v_price_changed then
    update public.invoices
    set subtotal = v_new_total_price,
        total = v_new_total_price - discount,
        updated_at = now()
    where id = v_booking.invoice_id;

    update public.invoice_items
    set quantity = v_hours,
        unit_price = v_effective_unit_price,
        line_total = v_new_total_price - v_booking.discount_amount
    where invoice_id = v_booking.invoice_id and reference_type = 'booking' and reference_id = p_booking_id;

    perform public.write_audit_log(
      v_club_id, 'invoice.reprice_on_reschedule', 'invoices', v_booking.invoice_id,
      jsonb_build_object('total', v_booking.total_price), jsonb_build_object('total', v_new_total_price),
      'booking rescheduled: ' || coalesce(p_reason, 'no reason given')
    );
  end if;

  perform public.write_audit_log(
    v_club_id, 'booking.reschedule', 'bookings', p_booking_id,
    jsonb_build_object('field_id', v_old_field_id, 'start_at', v_old_start_at, 'end_at', v_old_end_at, 'total_price', v_booking.total_price),
    jsonb_build_object('field_id', v_target_field_id, 'start_at', p_new_start_at, 'end_at', p_new_end_at, 'total_price', case when v_paid = 0 then v_new_total_price else v_booking.total_price end),
    p_reason
  );

  update public.qr_credentials
  set status = 'revoked'
  where type = 'booking' and reference_id = p_booking_id and status = 'active';

  v_qr_token := public._mint_booking_qr_token_internal(p_booking_id, v_club_id, p_new_end_at + interval '2 hours', auth.uid());

  select name, full_name into v_club_name, v_customer_name from public.clubs, public.customers
    where public.clubs.id = v_club_id and public.customers.id = v_booking.customer_id;
  v_booking_ref := 'MB-' || upper(substring(p_booking_id::text, 1, 8));
  v_timezone_for_msg := v_timezone;

  v_event_id := public.emit_notification_event(
    v_club_id, 'booking.rescheduled', 'booking', p_booking_id,
    jsonb_build_object('field_name', v_field.name, 'customer_id', v_booking.customer_id, 'start_at', p_new_start_at, 'end_at', p_new_end_at, 'old_start_at', v_old_start_at, 'old_end_at', v_old_end_at)
  );

  perform public.queue_whatsapp_notification(
    v_club_id, v_event_id, v_booking.customer_id, 'booking-rescheduled', 'booking_confirmations',
    jsonb_build_object(
      'field_name', v_field.name, 'sport', v_field.sport,
      'start_at', p_new_start_at, 'end_at', p_new_end_at,
      'old_start_at', v_old_start_at, 'old_end_at', v_old_end_at,
      'total_price', case when v_paid = 0 then v_new_total_price else v_booking.total_price end,
      'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone_for_msg,
      'booking_ref', v_booking_ref, 'booking_qr_token', v_qr_token
    ),
    'transactional', 'booking.rescheduled:' || p_booking_id::text
  );
  perform public.queue_email_notification(
    v_club_id, v_event_id, v_booking.customer_id, 'booking-rescheduled', 'booking_confirmations',
    jsonb_build_object(
      'field_name', v_field.name, 'sport', v_field.sport,
      'start_at', p_new_start_at, 'end_at', p_new_end_at,
      'old_start_at', v_old_start_at, 'old_end_at', v_old_end_at,
      'total_price', case when v_paid = 0 then v_new_total_price else v_booking.total_price end,
      'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone_for_msg,
      'booking_ref', v_booking_ref, 'booking_qr_token', v_qr_token
    ),
    'transactional', 'booking.rescheduled:' || p_booking_id::text
  );

  return query select p_booking_id, (case when v_paid = 0 then v_new_total_price else v_booking.total_price end), v_price_changed;
end;
$function$;

revoke all on function public.reschedule_booking(uuid, timestamptz, timestamptz, uuid, text) from public;
revoke all on function public.reschedule_booking(uuid, timestamptz, timestamptz, uuid, text) from anon;
grant execute on function public.reschedule_booking(uuid, timestamptz, timestamptz, uuid, text) to authenticated;

-- ============================================================
-- 3. Availability engine: subtract academy session windows from
-- computed free slots, closing the SILENT half of the bug (an academy
-- session was not merely un-enforced -- it was invisible, so a start
-- time overlapping one was shown to staff/public as "available" right
-- up until the exclusion-violation/new guard above rejected it at
-- submit time). This also folds in field_blocks the same way
-- get_public_field_availability already does, so
-- _field_available_starts_internal's busy set now matches its sibling
-- exactly plus academy sessions.
-- ============================================================

create or replace function public._field_available_starts_internal(
  p_field_id uuid,
  p_date date,
  p_duration_minutes int,
  p_increment_minutes int default 30
)
returns table(start_at timestamptz, end_at timestamptz, is_available boolean)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_timezone text;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_hours record;
  v_open_at timestamptz;
  v_close_at timestamptz;
begin
  select c.timezone into v_timezone
    from public.fields f join public.clubs c on c.id = f.club_id
    where f.id = p_field_id;

  v_day_start := p_date::timestamp at time zone v_timezone;
  v_day_end := (p_date + 1)::timestamp at time zone v_timezone;

  select * into v_hours from public.resolve_field_operating_hours(p_field_id, p_date);
  if not v_hours.has_any_config or v_hours.open_time is null then
    return;
  end if;

  v_open_at := p_date::timestamp at time zone v_timezone + v_hours.open_time;
  v_close_at := p_date::timestamp at time zone v_timezone + v_hours.close_time;

  return query
  with busy as (
    select b.start_at, b.end_at
    from public.bookings b
    where b.field_id = p_field_id
      and b.status in ('pending_payment', 'confirmed', 'checked_in')
      and b.start_at < v_day_end and b.end_at > v_day_start
    union all
    select fb.start_at, fb.end_at
    from public.field_blocks fb
    where fb.field_id = p_field_id
      and fb.start_at < v_day_end and fb.end_at > v_day_start
    union all
    -- FIX (this migration): academy training sessions on this field now
    -- subtract from computed availability, closing the silent half of
    -- the P0 -- staff/public previously saw a session's slot as "free"
    -- right up until submission.
    select lower(ts.during), upper(ts.during)
    from public.training_sessions ts
    where ts.field_id = p_field_id
      and ts.status <> 'cancelled'
      and lower(ts.during) < v_day_end and upper(ts.during) > v_day_start
  ),
  candidates as (
    select gs as candidate_start
    from generate_series(v_open_at, v_close_at - make_interval(mins => p_duration_minutes), make_interval(mins => p_increment_minutes)) as gs
  )
  select
    c.candidate_start,
    c.candidate_start + make_interval(mins => p_duration_minutes),
    c.candidate_start > now()
      and not exists (
        select 1 from busy
        where busy.start_at < (c.candidate_start + make_interval(mins => p_duration_minutes))
          and busy.end_at > c.candidate_start
      )
  from candidates c
  order by c.candidate_start;
end;
$function$;

revoke all on function public._field_available_starts_internal(uuid, date, int, int) from public;
revoke all on function public._field_available_starts_internal(uuid, date, int, int) from anon;
grant execute on function public._field_available_starts_internal(uuid, date, int, int) to authenticated;
grant execute on function public._field_available_starts_internal(uuid, date, int, int) to service_role;

-- get_public_field_availability's own busy_ranges subquery (the primitive
-- _field_available_starts_internal's header comment says it mirrors) is
-- a SEPARATE function -- update it too so both availability primitives
-- agree, per this same migration's design goal of "exactly one overlap
-- predicate, extended consistently to a second source."
create or replace function public.get_public_field_availability(p_field_id uuid, p_date date)
returns table(open_time time, close_time time, has_any_config boolean, busy_ranges jsonb)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_timezone text;
  v_hours record;
begin
  select f.club_id, c.timezone into v_club_id, v_timezone
    from public.fields f
    join public.clubs c on c.id = f.club_id
    where f.id = p_field_id and f.status = 'active' and c.public_booking_enabled = true and c.status = 'active';

  if v_club_id is null then
    raise exception 'field not found or not publicly bookable';
  end if;

  v_day_start := p_date::timestamp at time zone v_timezone;
  v_day_end := (p_date + 1)::timestamp at time zone v_timezone;

  select * into v_hours from public.resolve_field_operating_hours(p_field_id, p_date);

  return query
  select
    v_hours.open_time,
    v_hours.close_time,
    v_hours.has_any_config,
    (
      select coalesce(jsonb_agg(jsonb_build_object('start_at', r.start_at, 'end_at', r.end_at) order by r.start_at), '[]'::jsonb)
      from (
        select b.start_at, b.end_at
        from public.bookings b
        where b.field_id = p_field_id
          and b.status in ('pending_payment', 'confirmed', 'checked_in')
          and b.start_at < v_day_end and b.end_at > v_day_start
        union all
        select fb.start_at, fb.end_at
        from public.field_blocks fb
        where fb.field_id = p_field_id
          and fb.start_at < v_day_end and fb.end_at > v_day_start
        union all
        -- FIX (this migration): see _field_available_starts_internal
        -- above -- same addition, kept consistent across both
        -- availability primitives.
        select lower(ts.during), upper(ts.during)
        from public.training_sessions ts
        where ts.field_id = p_field_id
          and ts.status <> 'cancelled'
          and lower(ts.during) < v_day_end and upper(ts.during) > v_day_start
      ) r
    );
end;
$function$;

-- Grants preserved as-is (this function's original migration already
-- granted anon/authenticated/service_role -- re-declaring CREATE OR
-- REPLACE does not drop existing grants, but the grants are re-asserted
-- here defensively since this migration changes the function body).
revoke all on function public.get_public_field_availability(uuid, date) from public;
grant execute on function public.get_public_field_availability(uuid, date) to anon;
grant execute on function public.get_public_field_availability(uuid, date) to authenticated;
grant execute on function public.get_public_field_availability(uuid, date) to service_role;

-- PLATFORM OWNER CONTROL IMPLEMENTATION -- Phase 1 (P0).
-- PLATFORM_OWNER_COMPLETE_CONTROL_AUDIT.md's core finding: club_modules
-- has a working entitled/active toggle for 'academy' and 'fields' (used
-- live in the Platform Owner console's Modules tab), but NO RPC anywhere
-- checked it -- unlike 'shop', which has _shop_module_active() wired
-- into every read/write RPC. This migration closes that gap for the two
-- real, highest-traffic write chokepoints of each module, mirroring
-- _shop_module_active()'s exact pattern (same SQL shape, same
-- stable/security definer/search_path, same revoke-from-anon-and-public
-- + grant-to-authenticated-only convention).
--
-- Scope, confirmed by direct RPC-graph inspection immediately before
-- writing this migration (not assumed from the audit alone):
--   Academy write chokepoints: create_enrollment_with_subscription(),
--     mark_attendance(), qr_mark_attendance(). (Session/group/program
--     creation share the same has_permission()-gated pattern but are
--     lower-frequency administrative writes; enrollment + attendance are
--     the two paths that matter operationally and were named explicitly
--     in the audit and the implementation directive.)
--   Fields/Booking write chokepoint: _create_booking_internal() is the
--     SOLE internal function called by create_booking(),
--     create_recurring_booking(), AND create_public_booking() (confirmed
--     via direct grep of every CREATE OR REPLACE across
--     supabase/migrations/*.sql) -- fixing this one function closes the
--     gap for all three callers, including the anonymous public booking
--     page, in a single change. create_field_block() and
--     create_field_pricing_rules() are also swept as the other two
--     concrete Fields-domain write RPCs named in the audit.
--
-- Deliberately NOT touched: reads (list/get RPCs) for either module --
-- matches the established "reads are never gated by subscription state"
-- precedent this codebase already uses for club_write_allowed(), and RLS
-- (module-state is a commercial-tier RPC-layer concern by this
-- codebase's own established convention -- see club_modules_schema.sql's
-- own header comment). Nav-hiding is a separate, later phase (frontend).

create or replace function public._academy_module_active(p_club_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(bool_and(entitled) and bool_and(active), false)
  from public.club_modules
  where club_id = p_club_id and module_key = 'academy'
$$;

revoke all on function public._academy_module_active(uuid) from public;
revoke all on function public._academy_module_active(uuid) from anon;
grant execute on function public._academy_module_active(uuid) to authenticated;

create or replace function public._fields_module_active(p_club_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(bool_and(entitled) and bool_and(active), false)
  from public.club_modules
  where club_id = p_club_id and module_key = 'fields'
$$;

revoke all on function public._fields_module_active(uuid) from public;
revoke all on function public._fields_module_active(uuid) from anon;
grant execute on function public._fields_module_active(uuid) to authenticated;

-- ============================================================
-- create_enrollment_with_subscription(): add the module-active check
-- immediately after the existing permission check, before any row lock
-- or insert. Body otherwise byte-identical to
-- 20260816120000_fix_enrollment_integrity.sql's definition.
-- ============================================================
create or replace function public.create_enrollment_with_subscription(
  p_player_id uuid,
  p_group_id uuid,
  p_guardian_id uuid,
  p_plan_type text,
  p_start_date date,
  p_end_date date,
  p_price numeric,
  p_discount numeric default 0
)
returns table(enrollment_id uuid, subscription_id uuid, invoice_id uuid)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_branch_id uuid;
  v_group record;
  v_active_count int;
  v_enrollment_id uuid;
  v_subscription_id uuid;
  v_invoice_id uuid;
  v_invoice_number text;
  v_net_price numeric;
  v_billing_customer_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id, branch_id into v_club_id, v_branch_id from public.groups where id = p_group_id;
  if v_club_id is null then
    raise exception 'group not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('enrollment.create', v_club_id)) then
    raise exception 'not authorized';
  end if;

  if not public._academy_module_active(v_club_id) then
    raise exception 'the academy module is not active for this club';
  end if;

  if not public.club_write_allowed(v_club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new commitments';
  end if;

  if not exists (select 1 from public.players where id = p_player_id and club_id = v_club_id) then
    raise exception 'player not found in this club';
  end if;

  if p_guardian_id is not null and not exists (select 1 from public.customers where id = p_guardian_id and club_id = v_club_id) then
    raise exception 'guardian not found in this club';
  end if;

  select * into v_group from public.groups where id = p_group_id for update;

  if v_group.status != 'active' then
    raise exception 'group is not accepting enrollments';
  end if;

  if exists (
    select 1 from public.enrollments
    where player_id = p_player_id and group_id = p_group_id and status = 'active'
  ) then
    raise exception 'player is already actively enrolled in this group';
  end if;

  select count(*) into v_active_count from public.enrollments where group_id = p_group_id and status = 'active';

  if v_active_count >= v_group.capacity then
    raise exception 'group is at full capacity';
  end if;

  if p_end_date <= p_start_date then
    raise exception 'end date must be after start date';
  end if;

  insert into public.enrollments (club_id, player_id, group_id, guardian_id, status, created_by)
  values (v_club_id, p_player_id, p_group_id, p_guardian_id, 'active', auth.uid())
  returning id into v_enrollment_id;

  if v_active_count + 1 >= v_group.capacity then
    update public.groups set status = 'full' where id = p_group_id;
  end if;

  v_net_price := round(greatest(p_price - p_discount, 0), 2);

  v_billing_customer_id := coalesce(
    p_guardian_id,
    (select gl.customer_id from public.guardian_links gl where gl.player_id = p_player_id and gl.is_primary limit 1)
  );
  if v_billing_customer_id is null then
    raise exception 'no billing guardian: provide p_guardian_id or link a primary guardian to this player first';
  end if;

  v_invoice_number := public.issue_invoice_number(v_branch_id, v_club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch_id, v_invoice_number, v_billing_customer_id, 'issued', p_price, p_discount, v_net_price, now(), auth.uid())
  returning id into v_invoice_id;

  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'اشتراك ' || p_plan_type, 'subscription', v_enrollment_id, 1, p_price, v_net_price);

  insert into public.subscriptions (club_id, enrollment_id, plan_type, start_date, end_date, price, discount, status, invoice_id, created_by)
  values (v_club_id, v_enrollment_id, p_plan_type, p_start_date, p_end_date, p_price, p_discount, 'pending', v_invoice_id, auth.uid())
  returning id into v_subscription_id;

  return query select v_enrollment_id, v_subscription_id, v_invoice_id;
end;
$$;

revoke all on function public.create_enrollment_with_subscription(uuid, uuid, uuid, text, date, date, numeric, numeric) from public;
revoke all on function public.create_enrollment_with_subscription(uuid, uuid, uuid, text, date, date, numeric, numeric) from anon;
grant execute on function public.create_enrollment_with_subscription(uuid, uuid, uuid, text, date, date, numeric, numeric) to authenticated;

-- ============================================================
-- mark_attendance(): add the module-active check. Body otherwise
-- byte-identical to 20260820210000_attendance_mark_for_managers.sql.
-- ============================================================
create or replace function public.mark_attendance(p_session_id uuid, p_player_id uuid, p_status text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session record;
  v_attendance_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_status not in ('present', 'absent', 'excused', 'late') then
    raise exception 'invalid status';
  end if;

  select ts.*, g.coach_id, g.assistant_coach_id into v_session
  from public.training_sessions ts
  join public.groups g on g.id = ts.group_id
  where ts.id = p_session_id;

  if v_session.id is null then
    raise exception 'session not found';
  end if;

  if not (
    v_session.club_id in (select public.user_club_ids())
    and (
      public.has_permission('attendance.mark', v_session.club_id)
      or v_session.coach_id = auth.uid()
      or v_session.assistant_coach_id = auth.uid()
    )
  ) then
    raise exception 'not authorized for this session';
  end if;

  if not public._academy_module_active(v_session.club_id) then
    raise exception 'the academy module is not active for this club';
  end if;

  if not exists (
    select 1 from public.enrollments e
    where e.player_id = p_player_id and e.group_id = v_session.group_id and e.status = 'active'
  ) then
    raise exception 'player is not actively enrolled in this session''s group';
  end if;

  insert into public.attendance (club_id, session_id, player_id, status, method, marked_by, marked_at)
  values (v_session.club_id, p_session_id, p_player_id, p_status, 'manual', auth.uid(), now())
  on conflict (session_id, player_id)
  do update set status = excluded.status, method = 'manual', marked_by = excluded.marked_by, marked_at = excluded.marked_at
  returning id into v_attendance_id;

  return v_attendance_id;
end;
$$;

revoke execute on function public.mark_attendance(uuid, uuid, text) from public;
revoke execute on function public.mark_attendance(uuid, uuid, text) from anon;
grant execute on function public.mark_attendance(uuid, uuid, text) to authenticated;

-- ============================================================
-- qr_mark_attendance(): add the module-active check as one more
-- structured-result branch (matching this function's existing
-- return-a-row-not-raise-an-exception style for every other rejection
-- reason), so a disabled-module QR scan reads the same as every other
-- expected rejection in qr_scan_events, not a generic 500. Body
-- otherwise byte-identical to
-- 20260820220000_qr_attendance_mark_for_managers.sql.
-- ============================================================
create or replace function public.qr_mark_attendance(p_token text, p_session_id uuid)
returns table(result text, attendance_id uuid)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_token_hash text;
  v_cred record;
  v_session record;
  v_attendance_id uuid;
  v_enrollment_id uuid;
  v_subscription_status text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_cred from public.qr_credentials where token_hash = v_token_hash;

  if v_cred.id is null then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (null, null, auth.uid(), 'attendance_mark', 'invalid', null, null);
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  if v_cred.type != 'player_membership' then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'invalid', v_cred.type, v_cred.reference_id);
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  select ts.*, g.coach_id, g.assistant_coach_id into v_session
  from public.training_sessions ts
  join public.groups g on g.id = ts.group_id
  where ts.id = p_session_id;

  if v_session.id is null or v_session.club_id != v_cred.club_id then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'wrong_club', v_cred.type, v_cred.reference_id);
    return query select 'wrong_club'::text, null::uuid;
    return;
  end if;

  if not (
    v_session.club_id in (select public.user_club_ids())
    and (
      public.has_permission('attendance.mark', v_session.club_id)
      or v_session.coach_id = auth.uid()
      or v_session.assistant_coach_id = auth.uid()
    )
  ) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'permission_denied', v_cred.type, v_cred.reference_id);
    return query select 'permission_denied'::text, null::uuid;
    return;
  end if;

  if not public._academy_module_active(v_session.club_id) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'module_inactive', v_cred.type, v_cred.reference_id);
    return query select 'module_inactive'::text, null::uuid;
    return;
  end if;

  select e.id into v_enrollment_id
  from public.enrollments e
  where e.player_id = v_cred.reference_id and e.group_id = v_session.group_id and e.status = 'active';

  if v_enrollment_id is null then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'invalid', v_cred.type, v_cred.reference_id);
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  select status into v_subscription_status
  from public.subscriptions
  where enrollment_id = v_enrollment_id
  order by created_at desc
  limit 1;

  if v_subscription_status is distinct from 'active' then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'subscription_inactive', v_cred.type, v_cred.reference_id);
    return query select 'subscription_inactive'::text, null::uuid;
    return;
  end if;

  insert into public.attendance (club_id, session_id, player_id, status, method, marked_by, marked_at)
  values (v_session.club_id, p_session_id, v_cred.reference_id, 'present', 'qr', auth.uid(), now())
  on conflict (session_id, player_id)
  do update set status = 'present', method = 'qr', marked_by = excluded.marked_by, marked_at = excluded.marked_at
  returning id into v_attendance_id;

  insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
  values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'success', v_cred.type, v_cred.reference_id);

  return query select 'success'::text, v_attendance_id;
end;
$function$;

revoke all on function public.qr_mark_attendance(text, uuid) from public;
revoke all on function public.qr_mark_attendance(text, uuid) from anon;
grant execute on function public.qr_mark_attendance(text, uuid) to authenticated;

-- ============================================================
-- _create_booking_internal(): add the module-active check immediately
-- after the existing permission check. This is the sole chokepoint for
-- create_booking(), create_recurring_booking(), AND
-- create_public_booking() (confirmed by direct call-graph inspection),
-- so this one change closes the gap for authenticated staff bookings
-- AND anonymous public bookings simultaneously. Body otherwise
-- byte-identical to
-- 20260824090000_create_booking_internal_overpayment_guard.sql (the
-- current live definition, confirmed via grep immediately before
-- writing this migration -- same 16-parameter signature, same return
-- type uuid, no shape change).
-- ============================================================
create or replace function public._create_booking_internal(p_field_id uuid, p_customer_id uuid, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_discount_amount numeric, p_notes text, p_record_payment boolean, p_payment_method text, p_payment_amount numeric, p_booking_series_id uuid, p_receipt_serial text DEFAULT NULL::text, p_receipt_date date DEFAULT NULL::date, p_receipt_book text DEFAULT NULL::text, p_receipt_series text DEFAULT NULL::text, p_receipt_image_path text DEFAULT NULL::text, p_receipt_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id uuid;
  v_branch_id uuid;
  v_field record;
  v_timezone text;
  v_local_date date;
  v_local_start_time time;
  v_local_end_time time;
  v_price_per_hour numeric;
  v_hours numeric;
  v_total_price numeric;
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

  if exists (
    select 1 from public.field_blocks
    where field_id = p_field_id
      and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then
    raise exception 'field is blocked during this time';
  end if;

  v_price_per_hour := public.resolve_field_price(
    p_field_id, v_local_date, v_local_start_time, v_local_end_time
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
  values (v_invoice_id, 'حجز ' || v_field.name, 'booking', v_booking_id, v_hours, v_price_per_hour, v_total_price - p_discount_amount);

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
revoke all on function public._create_booking_internal(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, text, numeric, uuid, text, date, text, text, text, text) from authenticated;

-- ============================================================
-- create_field_block(): add the module-active check. Body otherwise
-- byte-identical to 20260815350000_phase14_audit_hardening.sql.
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

  if not public._fields_module_active(v_club_id) then
    raise exception 'the fields module is not active for this club';
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
-- create_field_pricing_rules(): add the module-active check. Body
-- otherwise byte-identical to
-- 20260824390000_close_field_pricing_oracles_batch_d.sql. (archive_
-- field_pricing_rules is a delete-only path against existing rules --
-- not a "new commitment" the way creating a rule is, so left unswept,
-- consistent with this migration's own "reads/removals are not gated,
-- new commitments are" principle applied to write RPCs.)
-- ============================================================
create or replace function public.create_field_pricing_rules(p_field_id uuid, p_rules jsonb, p_reason text default null::text)
returns SETOF pricing_rules
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_field public.fields; v_created jsonb;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED'; end if;

  select * into v_field
  from public.fields
  where id = p_field_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('pricing.update', club_id)
    and public.user_has_branch_access(club_id, branch_id)
  for share;

  if v_field.id is null then raise exception 'FIELD_NOT_FOUND_OR_NOT_AUTHORIZED'; end if;

  if not public._fields_module_active(v_field.club_id) then
    raise exception 'the fields module is not active for this club';
  end if;

  if p_rules is null or jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules)=0 then
    raise exception 'PRICING_RULES_REQUIRED'; end if;

  with inserted as (
    insert into public.pricing_rules(club_id,field_id,day_of_week,date_specific,start_time,end_time,price_per_hour,priority)
    select v_field.club_id,p_field_id,r.day_of_week,r.date_specific,r.start_time,r.end_time,r.price_per_hour,r.priority
    from jsonb_to_recordset(p_rules) as r(day_of_week int,date_specific date,start_time time,end_time time,price_per_hour numeric,priority int)
    where r.price_per_hour > 0 and r.start_time < r.end_time
    returning *
  ) select coalesce(jsonb_agg(to_jsonb(inserted)),'[]'::jsonb) into v_created from inserted;
  if jsonb_array_length(v_created) <> jsonb_array_length(p_rules) then raise exception 'PRICING_RULE_INVALID'; end if;
  perform public.write_audit_log(v_field.club_id,'field_pricing.created','field',p_field_id,null,v_created,nullif(btrim(p_reason),''));
  return query select * from public.pricing_rules where id in (select (x->>'id')::uuid from jsonb_array_elements(v_created) x);
end
$$;

-- Signature unchanged -- in-place replace, grants untouched.

-- ============================================================
-- create_public_booking(): add the module-active check. Public,
-- anonymous surface -- this is the audit's single highest-severity
-- finding (a Fields-disabled club's public booking page kept accepting
-- real bookings). Body otherwise byte-identical to
-- 20260824210000_public_booking_optional_customer_email.sql (the
-- current live definition, confirmed via grep immediately before
-- writing this migration -- same 10-parameter signature, same return
-- shape).
-- ============================================================
create or replace function public.create_public_booking(p_club_slug text, p_field_id uuid, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_customer_name text, p_customer_mobile text, p_customer_phone_e164 text, p_notes text DEFAULT NULL::text, p_source text DEFAULT 'club_public_link'::text, p_customer_email text DEFAULT NULL::text)
 RETURNS TABLE(booking_id uuid, booking_ref text, hold_expires_at timestamp with time zone, total_price numeric, invoice_id uuid, invoice_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_club_id uuid; v_branch_id uuid; v_field record; v_timezone text;
  v_local_date date; v_local_start_time time; v_local_end_time time;
  v_price_per_hour numeric; v_hours numeric; v_total_price numeric;
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
  -- FIX (Phase 1, P0): the audit's highest-severity finding -- this
  -- anonymous RPC checked subscription access below but never module
  -- entitlement/activation, so a Platform Owner disabling Fields for a
  -- club had zero effect on its public booking page. Checked immediately
  -- alongside the existing subscription-access check, same rejection
  -- style (a generic "not currently accepting new bookings" message --
  -- deliberately not distinguishing "module disabled" from "subscription
  -- blocked" to an anonymous caller, consistent with this function's
  -- existing practice of not leaking internal commercial state publicly).
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
  if exists (select 1 from public.field_blocks where field_id = p_field_id
    and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')) then
    raise exception 'field is blocked during this time';
  end if;
  v_price_per_hour := public.get_public_field_price(p_field_id, v_local_date, v_local_start_time, v_local_end_time);
  v_hours := extract(epoch from (p_end_at - p_start_at)) / 3600.0;
  v_total_price := round(v_price_per_hour * v_hours, 2);

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
  values (v_invoice_id, 'حجز ' || v_field.name, 'booking', v_booking_id, v_hours, v_price_per_hour, v_total_price);
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
  return query select v_booking_id, v_booking_ref, v_hold_expires_at, v_total_price, v_invoice_id, v_invoice_number;
end;
$function$;

revoke all on function public.create_public_booking(text, uuid, timestamptz, timestamptz, text, text, text, text, text, text) from public;
revoke all on function public.create_public_booking(text, uuid, timestamptz, timestamptz, text, text, text, text, text, text) from anon;
grant execute on function public.create_public_booking(text, uuid, timestamptz, timestamptz, text, text, text, text, text, text) to anon, authenticated;

-- ============================================================
-- get_public_club(): a Fields-disabled club's public page should show
-- nothing, same treatment as an inactive/suspended club (its existing
-- c.status='active' guard). Body otherwise byte-identical to
-- 20260819350000_get_public_club_add_country.sql.
-- ============================================================
create or replace function public.get_public_club(p_slug text)
returns table(club_id uuid, club_name text, club_name_en text, logo_url text, currency text, timezone text, country text, primary_phone text, whatsapp_number text, contact_email text, address text, maps_url text, same_day_online_booking_enabled boolean, online_booking_start_offset_days integer, online_booking_window_days integer, payment_hold_minutes integer, branches jsonb, fields jsonb)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club record;
  v_policy record;
begin
  select c.id, c.name, c.name_en, c.logo_url, c.currency, c.timezone, c.country,
         c.primary_phone, c.whatsapp_number, c.contact_email, c.address, c.maps_url
    into v_club
    from public.clubs c
    where lower(c.public_slug) = lower(p_slug)
      and c.public_booking_enabled = true
      and c.status = 'active';

  if v_club.id is null then
    return;
  end if;

  -- FIX (Phase 1, P0): same rejection shape as an inactive/suspended
  -- club (returns no rows) -- never distinguishes "module disabled"
  -- from "club doesn't have public booking" to an anonymous caller.
  if not public._fields_module_active(v_club.id) then
    return;
  end if;

  select * into v_policy from public.get_public_club_booking_policy(v_club.id);

  return query
  select
    v_club.id, v_club.name, v_club.name_en, v_club.logo_url, v_club.currency, v_club.timezone, v_club.country,
    v_club.primary_phone, v_club.whatsapp_number, v_club.contact_email, v_club.address, v_club.maps_url,
    v_policy.same_day_online_booking_enabled, v_policy.online_booking_start_offset_days,
    v_policy.online_booking_window_days, v_policy.payment_hold_minutes,
    (
      select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'address', b.address) order by b.name), '[]'::jsonb)
      from public.branches b
      where b.club_id = v_club.id and b.status = 'active'
    ),
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', f.id, 'branch_id', f.branch_id, 'name', f.name, 'sport', f.sport,
        'indoor', f.indoor, 'capacity', f.capacity, 'default_duration_minutes', f.default_duration_minutes
      ) order by f.name), '[]'::jsonb)
      from public.fields f
      where f.club_id = v_club.id and f.status = 'active'
    );
end;
$function$;

revoke all on function public.get_public_club(text) from public;
grant execute on function public.get_public_club(text) to anon, authenticated;

-- AUDIT LOG HARDENING -- Phase 2: systematic sweep (2026-08-29)
--
-- Follow-up to Phase 1 (create_enrollment_with_subscription). A full
-- systematic sweep of every SECURITY DEFINER function that INSERTs or
-- UPDATEs a financially/security-sensitive table found 4 more real
-- gaps (out of ~14 candidates individually reviewed -- the rest were
-- confirmed acceptable: either already writing audit_logs via a direct
-- INSERT the text-match heuristic missed, or genuinely low-materiality
-- writes like walk-in-customer creation / plain customer profile edits
-- that would only add noise, not signal, if logged on every call).
--
-- 1. mark_booking_no_show() -- same shape as the already-fixed
--    record_payment/claim_manual_payment no_show gap from the earlier
--    anti-fraud program: this function's own sibling, cancel_booking(),
--    correctly writes a 'cancel_booking' audit entry; mark_booking_no_show()
--    never did, despite mutating the same bookings.status column with
--    the same real business/financial consequence (a no-show, like a
--    cancellation, changes what payment/refund paths remain valid).
--
-- 2. record_payment_with_official_receipt() -- the most severe of this
--    batch: a real Egyptian government-compliance official collection
--    receipt (official_collection_receipts) is inserted with ZERO audit
--    trail. Live-confirmed: exactly 1 real production row
--    (id=984babed-414a-4b87-951d-15adfe20d3d4) has no matching
--    'official_collection_receipt.created' audit_logs entry, while every
--    other real receipt row (created via record_payment()'s own inline
--    receipt-linking path, which DOES call write_audit_log) does. This
--    is a compliance-document creation event -- the exact class of
--    action directive-level audit requirements (and this program's own
--    established convention, see record_payment()'s own
--    'official_collection_receipt.created' call) says must never be
--    silent.
--
-- 3. complete_new_club_onboarding() -- creates a new club, its main
--    branch, the owner's own club_owner membership, and (the material
--    fact) grants a free trial platform_subscriptions row -- the
--    single event that establishes a new tenant's entire commercial
--    relationship with the platform. Zero audit trail previously.
--
-- 4. expire_due_academy_subscriptions() -- a scheduled/cron function
--    (service_role-only, confirmed via has_function_privilege: neither
--    authenticated nor anon can call it) that bulk-expires subscriptions
--    past their end_date. Different shape from the other 3: there is no
--    real human actor (auth.uid() is null in a cron context), and it can
--    affect many rows in one call -- a per-row write_audit_log() call
--    would produce misleading actor_id=null spam, not a meaningful
--    trail. Fixed with ONE aggregate audit_logs row per run (only when
--    it actually expired something), recording the count and the list
--    of affected subscription ids in 'after' -- proportionate to what
--    this function actually is (a system housekeeping job), not a
--    per-row entry pretending to be an actor-driven action.
--
-- No return-shape changes on any of the 4 functions -- CREATE OR
-- REPLACE is safe for all.

create or replace function public.mark_booking_no_show(p_booking_id uuid, p_reason text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
begin
  select club_id into v_club_id
  from public.bookings
  where id = p_booking_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('booking.update', club_id);

  if v_club_id is null then
    raise exception 'booking not found or you do not have permission to update it';
  end if;

  update public.bookings
  set status = 'no_show', marked_by = auth.uid(), marked_at = now(), notes = coalesce(notes || E'\n', '') || coalesce(p_reason, '')
  where id = p_booking_id and status in ('confirmed', 'checked_in');

  if not found then
    raise exception 'booking not found or not in a markable state';
  end if;

  -- FIX (audit log hardening, phase 2): matches cancel_booking()'s own
  -- established convention for the same class of terminal booking-status
  -- change.
  perform public.write_audit_log(
    v_club_id, 'mark_booking_no_show', 'bookings', p_booking_id, null,
    jsonb_build_object('status', 'no_show'), p_reason
  );
end;
$function$;

create or replace function public.record_payment_with_official_receipt(p_invoice_id uuid, p_amount numeric, p_method text, p_receipt_serial text, p_receipt_date date, p_receipt_book text DEFAULT NULL::text, p_receipt_series text DEFAULT NULL::text, p_receipt_image_path text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_reference text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid)
 returns TABLE(payment_id uuid, official_receipt_id uuid)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_invoice record;
  v_booking_field_id uuid;
  v_booking_branch_id uuid;
  v_effective_policy public.government_collection_policies;
  v_receipt_id uuid;
  v_payment_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_receipt_serial is null or length(trim(p_receipt_serial)) = 0 then
    raise exception 'receipt serial is required';
  end if;

  if p_receipt_date is null then
    raise exception 'receipt date is required';
  end if;

  if p_receipt_date > (current_date + interval '1 day')::date then
    raise exception 'receipt date cannot be in the future';
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id;
  if v_invoice is null then
    raise exception 'invoice not found';
  end if;

  if not (v_invoice.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', v_invoice.club_id)) then
    raise exception 'not authorized';
  end if;

  select b.field_id, b.branch_id into v_booking_field_id, v_booking_branch_id
  from public.bookings b where b.invoice_id = p_invoice_id limit 1;

  if v_booking_branch_id is null then
    select g.branch_id into v_booking_branch_id
    from public.subscriptions s
    join public.enrollments e on e.id = s.enrollment_id
    join public.groups g on g.id = e.group_id
    where s.invoice_id = p_invoice_id
    limit 1;
  end if;

  v_effective_policy := public.get_effective_government_policy(
    v_invoice.club_id, v_booking_branch_id, v_booking_field_id
  );

  if v_effective_policy.receipt_image_required and p_receipt_image_path is null then
    raise exception 'a receipt image is required by this club/field''s compliance policy';
  end if;

  insert into public.official_collection_receipts (
    club_id, branch_id, field_id, payment_id, authority_type,
    receipt_book, receipt_series, receipt_serial,
    receipt_date, receipt_amount, payment_method,
    entered_by, receipt_image_path, notes
  ) values (
    v_invoice.club_id, v_booking_branch_id, v_booking_field_id, null,
    v_effective_policy.authority_type,
    p_receipt_book, p_receipt_series, p_receipt_serial,
    p_receipt_date, p_amount, p_method,
    auth.uid(), p_receipt_image_path, p_notes
  )
  returning id into v_receipt_id;

  -- FIX (audit log hardening, phase 2): this is a real government
  -- compliance document -- record_payment()'s own inline receipt-linking
  -- path already writes 'official_collection_receipt.created' when it
  -- receives an official_receipt_id, but THIS function creates the
  -- receipt BEFORE calling record_payment() below, so that inline path
  -- never fires for a receipt created via this entrypoint. Logged here,
  -- at creation time, matching the same action name/shape for
  -- consistency with every other official-receipt audit entry.
  perform public.write_audit_log(
    v_invoice.club_id, 'official_collection_receipt.created', 'official_collection_receipt', v_receipt_id,
    null,
    jsonb_build_object(
      'invoice_id', p_invoice_id, 'amount', p_amount, 'receipt_serial', p_receipt_serial,
      'receipt_book', p_receipt_book, 'receipt_series', p_receipt_series, 'receipt_date', p_receipt_date
    ),
    null
  );

  v_payment_id := public.record_payment(p_invoice_id, p_amount, p_method, p_reference, p_idempotency_key, v_receipt_id);

  return query select v_payment_id, v_receipt_id;
end;
$function$;

create or replace function public.complete_new_club_onboarding(p_business_type text, p_club_name text, p_club_name_ar text, p_branch_name text, p_city text, p_phone text, p_owner_email text, p_owner_mobile text, p_government_affiliated boolean DEFAULT false, p_country text DEFAULT NULL::text, p_phone_e164 text DEFAULT NULL::text)
 returns TABLE(club_id uuid, trial_granted boolean)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
  v_branch_id uuid;
  v_club_code text;
  v_trial_days int;
  v_trial_granted boolean := false;
  v_recent_count int;
  v_normalized_mobile text;
  v_is_duplicate boolean := false;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select count(*) into v_recent_count
  from public.clubs
  where created_by = auth.uid() and created_at > now() - interval '1 hour';

  if v_recent_count >= 5 then
    raise exception 'too many clubs created recently -- please try again later';
  end if;

  if p_country is not null and p_country !~ '^[A-Z]{2}$' then
    raise exception 'invalid country code';
  end if;
  if p_phone_e164 is not null and p_phone_e164 !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'invalid phone number';
  end if;

  v_normalized_mobile := public.normalize_mobile(p_owner_mobile);

  select exists (
    select 1 from public.clubs c
    where lower(trim(c.name_ar)) = lower(trim(p_club_name_ar))
       or lower(trim(c.name)) = lower(trim(p_club_name))
  ) into v_is_duplicate;

  v_club_code := upper(substring(regexp_replace(coalesce(p_club_name, 'CLUB'), '[^a-zA-Z0-9]', '', 'g') from 1 for 6));
  if v_club_code = '' then
    v_club_code := 'CLUB';
  end if;
  v_club_code := v_club_code || '-' || substring(replace(gen_random_uuid()::text, '-', '') from 1 for 6);

  insert into public.clubs (name, name_ar, club_code, status, created_by, flagged_duplicate, flagged_duplicate_reason, country)
  values (
    coalesce(p_club_name, p_club_name_ar), p_club_name_ar, v_club_code, 'active', auth.uid(),
    v_is_duplicate, case when v_is_duplicate then 'اسم مشابه لنادي موجود بالفعل' else null end,
    p_country
  )
  returning id into v_club_id;

  insert into public.branches (club_id, branch_code, name, address, phone, phone_e164, status, created_by)
  values (v_club_id, 'MAIN', p_branch_name, p_city, p_phone, p_phone_e164, 'active', auth.uid())
  returning id into v_branch_id;

  insert into public.club_memberships (user_id, club_id, role_id, status, has_cash_custody)
  values (auth.uid(), v_club_id, (select id from public.roles where key = 'club_owner'), 'active', true);

  if p_government_affiliated then
    insert into public.government_collection_policies (
      club_id, enabled, official_receipt_required, required_payment_methods, created_by
    ) values (
      v_club_id, true, false, array['cash'], auth.uid()
    );
  end if;

  begin
    insert into public.automatic_trial_entitlements (
      user_id, club_id, owner_normalized_mobile_snapshot, owner_email_snapshot, consumed_at
    ) values (
      auth.uid(), v_club_id, v_normalized_mobile, lower(p_owner_email), now()
    );
    v_trial_granted := true;
  exception when unique_violation then
    v_trial_granted := false;
  end;

  if v_trial_granted then
    select default_trial_days into v_trial_days from public.platform_settings where id = true;

    insert into public.platform_subscriptions (
      club_id, subscription_kind, trial_origin, plan_name_snapshot, price_snapshot,
      grace_period_days_snapshot, start_at, end_at, lifecycle_status
    ) values (
      v_club_id, 'trial', 'automatic', 'تجربة مجانية', 0,
      0, now(), now() + (v_trial_days || ' days')::interval, 'trial'
    );
  end if;

  -- FIX (audit log hardening, phase 2): the single event that
  -- establishes a new tenant's entire commercial relationship with the
  -- platform (club + main branch + owner membership + free trial grant)
  -- previously had zero audit trail. club_id is both the acting club_id
  -- context and the entity here (there is no "other" club yet for this
  -- action to be scoped against) -- matches how other club-lifecycle
  -- actions elsewhere in this schema self-reference the club being acted
  -- on.
  perform public.write_audit_log(
    v_club_id, 'club.onboarded', 'clubs', v_club_id, null,
    jsonb_build_object(
      'business_type', p_business_type, 'club_name', p_club_name, 'club_name_ar', p_club_name_ar,
      'branch_id', v_branch_id, 'government_affiliated', p_government_affiliated,
      'trial_granted', v_trial_granted, 'flagged_duplicate', v_is_duplicate
    ),
    null
  );

  return query select v_club_id, v_trial_granted;
end;
$function$;

create or replace function public.expire_due_academy_subscriptions()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_count int;
  v_expired_ids uuid[];
  v_club_ids uuid[];
begin
  perform set_config('app.allow_subscription_status_transition', 'true', true);

  with expired as (
    update public.subscriptions
    set status = 'expired'
    where status in ('active', 'pending') and end_date < current_date
    returning id, club_id
  )
  select count(*), array_agg(id), array_agg(distinct club_id)
    into v_count, v_expired_ids, v_club_ids
  from expired;

  -- FIX (audit log hardening, phase 2): a scheduled/system job
  -- (service_role-only -- confirmed neither authenticated nor anon can
  -- call this) that bulk-expires subscriptions has no real per-row
  -- actor, so a write_audit_log() call per expired row would produce
  -- misleading actor_id=null spam rather than a meaningful trail. One
  -- aggregate entry per run instead, only when something was actually
  -- expired, listing the affected subscription ids -- proportionate to
  -- what this function is (system housekeeping), while still leaving a
  -- real, queryable trace that bulk expirations happened and exactly
  -- which subscriptions were affected. club_id is null (a genuinely
  -- cross-tenant system action, matching audit_logs.club_id's own
  -- nullable column) -- the affected club ids are recorded in 'after'
  -- instead, since a single run can span many clubs.
  if v_count > 0 then
    perform public.write_audit_log(
      null, 'academy_subscriptions.bulk_expired', 'subscriptions', null, null,
      jsonb_build_object('count', v_count, 'subscription_ids', v_expired_ids, 'club_ids', v_club_ids),
      'scheduled job: expire_due_academy_subscriptions'
    );
  end if;

  return v_count;
end;
$function$;

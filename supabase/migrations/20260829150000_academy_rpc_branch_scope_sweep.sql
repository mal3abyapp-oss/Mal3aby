-- ZERO-TRUST ANTI-FRAUD HARDENING -- ACCEPTANCE GAP CLOSURE (2026-08-29)
--
-- Systemic follow-up to the attendance-marking auth-bypass fix
-- (20260829140000_fix_attendance_marking_auth_bypass_and_branch_scope.sql).
-- That fix's own investigation flagged the same missing-branch-scope
-- shape in 5 sibling academy RPCs, none of which call
-- user_has_branch_access() despite every other branch-aware write
-- surface in this schema (bookings, cash, government-receipt policy,
-- reports) doing so. Confirmed by direct code inspection this pass:
-- create_enrollment_with_subscription, renew_academy_subscription,
-- cancel_subscription, freeze_subscription, generate_training_sessions,
-- ensure_adhoc_attendance_session ALL check has_permission(...) on the
-- club but never re-check that the caller's own branch scope (via
-- membership_branches) covers the specific branch the group/enrollment/
-- subscription actually belongs to.
--
-- Impact: a staff member scoped to Branch A (via membership_branches)
-- but holding a club-wide permission grant (e.g. session.manage,
-- enrollment.create, subscription.update) could create/renew/cancel/
-- freeze academy commitments and generate sessions for a group in
-- Branch B of the SAME club -- a real branch-isolation bypass on
-- financial-write (enrollment/renewal create real invoices) and
-- operational-write (session generation, subscription status changes)
-- surfaces. Same class of gap already fixed for reports (Phase 4),
-- cash/receipts, and now attendance -- this closes the remaining
-- academy RPCs in one sweep rather than one migration per function.
--
-- Fix: add `if not public.user_has_branch_access(<club_id>, <branch_id>)
-- then raise exception 'you do not have access to this branch'; end if;`
-- to each function, placed immediately after the existing permission
-- check, matching the exact wording/placement used in the attendance
-- fix. cancel_subscription/freeze_subscription need one extra lookup
-- (branch_id via groups, through enrollments) since neither previously
-- joined that far; the other 4 already have branch_id (or the group
-- record it comes from) in scope.
--
-- No return-shape changes on any of the 5 functions -- CREATE OR
-- REPLACE is safe for all.

create or replace function public.create_enrollment_with_subscription(p_player_id uuid, p_group_id uuid, p_guardian_id uuid, p_plan_type text, p_start_date date, p_end_date date, p_price numeric, p_discount numeric DEFAULT 0)
 returns TABLE(enrollment_id uuid, subscription_id uuid, invoice_id uuid)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
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

  -- FIX (this pass): branch-scope re-check, matching every other
  -- branch-aware write surface in this schema.
  if not public.user_has_branch_access(v_club_id, v_branch_id) then
    raise exception 'you do not have access to this branch';
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
$function$;

create or replace function public.renew_academy_subscription(p_enrollment_id uuid, p_start_date date, p_end_date date, p_price numeric, p_discount numeric DEFAULT 0)
 returns TABLE(subscription_id uuid, invoice_id uuid)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_enrollment record;
  v_club_id uuid;
  v_branch_id uuid;
  v_current_status text;
  v_net_price numeric;
  v_billing_customer_id uuid;
  v_invoice_number text;
  v_invoice_id uuid;
  v_subscription_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select e.* into v_enrollment
  from public.enrollments e
  where e.id = p_enrollment_id
    and e.club_id in (select public.user_club_ids())
    and public.has_permission('enrollment.create', e.club_id);

  if v_enrollment.id is null then
    raise exception 'enrollment not found or you do not have permission to renew it';
  end if;
  v_club_id := v_enrollment.club_id;

  select g.branch_id into v_branch_id from public.groups g where g.id = v_enrollment.group_id;

  -- FIX (this pass): branch-scope re-check.
  if not public.user_has_branch_access(v_club_id, v_branch_id) then
    raise exception 'you do not have access to this branch';
  end if;

  if not public._academy_module_active(v_club_id) then
    raise exception 'the academy module is not active for this club';
  end if;

  if not public.club_write_allowed(v_club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new commitments';
  end if;

  if v_enrollment.status != 'active' then
    raise exception 'cannot renew a subscription for an enrollment that is not active';
  end if;

  select status into v_current_status from public.subscriptions
  where enrollment_id = p_enrollment_id
  order by created_at desc limit 1;

  if v_current_status is not null and v_current_status in ('pending', 'active', 'frozen') then
    raise exception 'this enrollment already has an active or pending subscription -- it must reach expired/cancelled before renewing';
  end if;

  if p_end_date <= p_start_date then
    raise exception 'end date must be after start date';
  end if;

  v_net_price := round(greatest(p_price - p_discount, 0), 2);

  v_billing_customer_id := coalesce(
    v_enrollment.guardian_id,
    (select gl.customer_id from public.guardian_links gl where gl.player_id = v_enrollment.player_id and gl.is_primary limit 1)
  );
  if v_billing_customer_id is null then
    raise exception 'no billing guardian: link a primary guardian to this player first';
  end if;

  v_invoice_number := public.issue_invoice_number(v_branch_id, v_club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch_id, v_invoice_number, v_billing_customer_id, 'issued', p_price, p_discount, v_net_price, now(), auth.uid())
  returning id into v_invoice_id;

  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'تجديد اشتراك شهري', 'subscription', p_enrollment_id, 1, p_price, v_net_price);

  insert into public.subscriptions (club_id, enrollment_id, plan_type, start_date, end_date, price, discount, status, invoice_id, created_by)
  values (v_club_id, p_enrollment_id, 'monthly', p_start_date, p_end_date, p_price, p_discount, 'pending', v_invoice_id, auth.uid())
  returning id into v_subscription_id;

  perform public.write_audit_log(
    v_club_id, 'subscription.renew', 'subscription', v_subscription_id, null,
    jsonb_build_object('enrollment_id', p_enrollment_id, 'start_date', p_start_date, 'end_date', p_end_date, 'price', p_price),
    null
  );

  return query select v_subscription_id, v_invoice_id;
end;
$function$;

create or replace function public.cancel_subscription(p_subscription_id uuid, p_reason text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_sub record;
  v_branch_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a cancellation reason is required';
  end if;

  select * into v_sub
  from public.subscriptions
  where id = p_subscription_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('subscription.update', club_id)
  for update;

  if v_sub.id is null then
    raise exception 'subscription not found or you do not have permission to cancel it';
  end if;

  -- FIX (this pass): branch-scope re-check, resolved via the
  -- subscription's own enrollment -> group -> branch_id chain.
  select g.branch_id into v_branch_id
  from public.enrollments e join public.groups g on g.id = e.group_id
  where e.id = v_sub.enrollment_id;

  if v_branch_id is not null and not public.user_has_branch_access(v_sub.club_id, v_branch_id) then
    raise exception 'you do not have access to this branch';
  end if;

  if v_sub.status = 'cancelled' then
    raise exception 'subscription is already cancelled';
  end if;

  perform set_config('app.allow_subscription_status_transition', 'true', true);
  update public.subscriptions set status = 'cancelled' where id = p_subscription_id;

  perform public.write_audit_log(
    v_sub.club_id, 'subscription.cancel', 'subscription', p_subscription_id,
    jsonb_build_object('previous_status', v_sub.status), null,
    p_reason
  );
end;
$function$;

create or replace function public.freeze_subscription(p_subscription_id uuid, p_start_date date, p_end_date date, p_reason text DEFAULT NULL::text, p_extends_expiry boolean DEFAULT true)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_sub record;
  v_freeze_id uuid;
  v_branch_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_sub
  from public.subscriptions
  where id = p_subscription_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('subscription.freeze.create', club_id);

  if v_sub.id is null then
    raise exception 'subscription not found or you do not have permission to freeze it';
  end if;

  -- FIX (this pass): branch-scope re-check, same resolution path as
  -- cancel_subscription above.
  select g.branch_id into v_branch_id
  from public.enrollments e join public.groups g on g.id = e.group_id
  where e.id = v_sub.enrollment_id;

  if v_branch_id is not null and not public.user_has_branch_access(v_sub.club_id, v_branch_id) then
    raise exception 'you do not have access to this branch';
  end if;

  if v_sub.status not in ('active', 'frozen') then
    raise exception 'only an active subscription can be frozen';
  end if;

  if p_end_date <= p_start_date then
    raise exception 'end date must be after start date';
  end if;

  insert into public.subscription_freezes (club_id, subscription_id, start_date, end_date, reason, extends_expiry, created_by)
  values (v_sub.club_id, p_subscription_id, p_start_date, p_end_date, p_reason, p_extends_expiry, auth.uid())
  returning id into v_freeze_id;

  perform set_config('app.allow_subscription_status_transition', 'true', true);
  update public.subscriptions set status = 'frozen' where id = p_subscription_id;

  perform public.write_audit_log(v_sub.club_id, 'subscription.freeze', 'subscription', p_subscription_id, null, jsonb_build_object('start_date', p_start_date, 'end_date', p_end_date, 'extends_expiry', p_extends_expiry), p_reason);

  return v_freeze_id;
end;
$function$;

create or replace function public.generate_training_sessions(p_group_id uuid, p_through_date date)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_group record;
  v_slot record;
  v_date date;
  v_created_count int := 0;
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

  -- FIX (this pass): branch-scope re-check.
  if not public.user_has_branch_access(v_group.club_id, v_group.branch_id) then
    raise exception 'you do not have access to this branch';
  end if;

  if not public._academy_module_active(v_group.club_id) then
    raise exception 'the academy module is not active for this club';
  end if;

  if p_through_date < current_date then
    raise exception 'p_through_date must be today or later';
  end if;

  for v_slot in select * from public.group_schedule_slots where group_id = p_group_id loop
    v_date := current_date;
    while v_date <= p_through_date loop
      if extract(dow from v_date) = v_slot.day_of_week then
        insert into public.training_sessions (club_id, group_id, field_id, coach_id, session_date, start_time, end_time)
        values (v_group.club_id, p_group_id, v_group.field_id, v_group.coach_id, v_date, v_slot.start_time, v_slot.end_time)
        on conflict (group_id, session_date, start_time) do nothing;
        if found then
          v_created_count := v_created_count + 1;
        end if;
      end if;
      v_date := v_date + interval '1 day';
    end loop;
  end loop;

  return v_created_count;
end;
$function$;

create or replace function public.ensure_adhoc_attendance_session(p_group_id uuid, p_session_date date)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_group record;
  v_session_id uuid;
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

  -- FIX (this pass): branch-scope re-check.
  if not public.user_has_branch_access(v_group.club_id, v_group.branch_id) then
    raise exception 'you do not have access to this branch';
  end if;

  if not public._academy_module_active(v_group.club_id) then
    raise exception 'the academy module is not active for this club';
  end if;

  select id into v_session_id
  from public.training_sessions
  where group_id = p_group_id and session_date = p_session_date and start_time = '00:00:00'
  limit 1;

  if v_session_id is not null then
    return v_session_id;
  end if;

  insert into public.training_sessions (club_id, group_id, field_id, coach_id, session_date, start_time, end_time)
  values (v_group.club_id, p_group_id, v_group.field_id, v_group.coach_id, p_session_date, '00:00:00', '23:59:00')
  on conflict (group_id, session_date, start_time) do nothing
  returning id into v_session_id;

  if v_session_id is null then
    select id into v_session_id
    from public.training_sessions
    where group_id = p_group_id and session_date = p_session_date and start_time = '00:00:00'
    limit 1;
  end if;

  return v_session_id;
end;
$function$;

-- ZERO-TRUST ANTI-FRAUD HARDENING -- Phase 5 (2026-08-29)
--
-- Recon flagged Academy/Fields/Club-Membership module-entitlement
-- gating as the highest-probability real gap: each got its
-- _module_active() checks added in a single migration on 2026-08-28,
-- unlike Shop's 7+ dedicated sweep/verification passes. A full RPC-
-- surface audit of Academy's write path confirms this: 3 of 6 real
-- academy-data-writing RPCs never call _academy_module_active(), a real
-- module-disable bypass for "new commitment"-shaped writes:
--
--   - renew_academy_subscription(): checks club_write_allowed()
--     (subscription/billing gate) but never _academy_module_active() --
--     a club with Academy deactivated by Platform Owner could still
--     have staff create new academy subscriptions/invoices/billing
--     commitments through this RPC. The clearest, most fraud-relevant
--     gap of the three (directly creates new financial commitments).
--   - ensure_adhoc_attendance_session(): a real, frontend-reachable
--     write path (AttendanceSection.tsx's "open today's ad-hoc
--     session" flow, called immediately before mark_attendance(),
--     which IS gated) -- creates a new training_sessions row with no
--     module check at all.
--   - generate_training_sessions(): same gap, the schedule-driven
--     bulk-session-creation sibling of the above.
--
-- mark_attendance()/qr_mark_attendance()/create_enrollment_with_subscription()
-- already correctly check _academy_module_active() (confirmed via
-- recon) and are unchanged by this migration.
--
-- Fix: add the same fail-closed check every other gated academy RPC
-- already uses, in the same place (after ownership/permission
-- resolution, before any write). All 3 return shapes are unchanged
-- (uuid / integer / TABLE(subscription_id, invoice_id) respectively) --
-- CREATE OR REPLACE is safe, no DROP FUNCTION needed.

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

create or replace function public.renew_academy_subscription(p_enrollment_id uuid, p_start_date date, p_end_date date, p_price numeric, p_discount numeric default 0)
returns table(subscription_id uuid, invoice_id uuid)
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

  if not public._academy_module_active(v_club_id) then
    raise exception 'the academy module is not active for this club';
  end if;

  select g.branch_id into v_branch_id from public.groups g where g.id = v_enrollment.group_id;

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

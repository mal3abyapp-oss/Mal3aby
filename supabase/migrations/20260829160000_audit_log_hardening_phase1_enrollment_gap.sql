-- AUDIT LOG HARDENING -- Phase 1 (2026-08-29)
--
-- Real gap found during a direct audit-log capability review (not the
-- anti-fraud program's own RPC sweep -- a separate, later request):
-- create_enrollment_with_subscription() creates a real enrollment,
-- invoice, and subscription (a genuine financial commitment -- the
-- FIRST money-relevant event for a newly enrolled player) but never
-- calls write_audit_log() at all. Its sibling function,
-- renew_academy_subscription(), does the near-identical shape of work
-- (insert invoice + insert subscription) and correctly writes a
-- 'subscription.renew' audit entry immediately after. Confirmed live:
-- `select count(*) from audit_logs where action ilike '%enrollment%'`
-- returned 0 despite real enrollment data existing -- every academy
-- enrollment ever created in this project is invisible in the audit
-- trail.
--
-- Fix: add the same write_audit_log() call this function's sibling
-- already uses, immediately after the subscription insert, recording
-- the full financial shape of what was created (player, group,
-- guardian/billing customer, plan, dates, price, discount, and the
-- linked invoice/subscription ids) as the 'after' snapshot -- matching
-- renew_academy_subscription()'s own convention of a null 'before'
-- (nothing existed previously) and a jsonb 'after' describing the new
-- state. Action name 'enrollment.created_with_subscription' distinct
-- from plain 'enrollment.created' (if that ever comes to exist
-- elsewhere) since this specific RPC creates the paired financial
-- commitment in the same transaction, which is the material fact this
-- entry exists to capture.
--
-- No return-shape change (still TABLE(enrollment_id, subscription_id,
-- invoice_id)) -- CREATE OR REPLACE is safe.

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

  -- FIX (audit log hardening, phase 1): this RPC creates a real
  -- financial commitment (invoice + subscription) and previously wrote
  -- zero audit trail -- matching renew_academy_subscription()'s own
  -- established convention (null 'before', jsonb 'after' describing
  -- the new state).
  perform public.write_audit_log(
    v_club_id, 'enrollment.created_with_subscription', 'subscription', v_subscription_id, null,
    jsonb_build_object(
      'enrollment_id', v_enrollment_id, 'player_id', p_player_id, 'group_id', p_group_id,
      'guardian_id', p_guardian_id, 'billing_customer_id', v_billing_customer_id,
      'plan_type', p_plan_type, 'start_date', p_start_date, 'end_date', p_end_date,
      'price', p_price, 'discount', p_discount, 'invoice_id', v_invoice_id
    ),
    null
  );

  return query select v_enrollment_id, v_subscription_id, v_invoice_id;
end;
$function$;

-- ACADEMY OPERATIONS FULL AUTONOMOUS PRODUCTION HARDENING, Batch A:
-- fixes AC1-AC6 (see ACADEMY_PRODUCTION_ACCEPTANCE.md). Each function
-- is CREATE OR REPLACE over its own live current body -- every other
-- line is byte-identical to what's already deployed; only the
-- specific defect lines change, following the same discipline as
-- every prior migration in this repo.

-- ---------------------------------------------------------------
-- AC1 + AC2: renew_academy_subscription
--   AC1: plan_type was hardcoded to 'monthly' in the INSERT instead
--        of preserving the enrollment's actual prior plan_type --
--        every renewal of a quarterly/season/package subscription
--        silently downgraded its recorded plan type.
--   AC2: no explicit negative-discount rejection before
--        v_net_price := greatest(p_price - p_discount, 0) -- a
--        negative p_discount silently INFLATES the price rather than
--        discounting it, and would only be caught late (and badly --
--        a raw constraint-violation error) by subscriptions'
--        discount >= 0 check, by which point an invoice row with a
--        bad discount value had already been inserted in the same
--        transaction. Exact same fix pattern as the booking-side D5
--        fix (reject_negative_booking_discount_amount): reject with a
--        clean, named error BEFORE any computation uses the value.
-- ---------------------------------------------------------------
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
  v_player_name text;
  v_group_name text;
  v_prior_plan_type text;
  v_plan_type_ar text;
  v_description text;
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

  select g.branch_id, g.name into v_branch_id, v_group_name from public.groups g where g.id = v_enrollment.group_id;

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

  select status, plan_type into v_current_status, v_prior_plan_type from public.subscriptions
  where enrollment_id = p_enrollment_id
  order by created_at desc limit 1;

  if v_current_status is not null and v_current_status in ('pending', 'active', 'frozen') then
    raise exception 'this enrollment already has an active or pending subscription -- it must reach expired/cancelled before renewing';
  end if;

  if p_end_date <= p_start_date then
    raise exception 'end date must be after start date';
  end if;

  -- AC2 fix: reject a negative discount before it can inflate the
  -- price or reach any insert.
  if p_discount < 0 then
    raise exception 'discount amount cannot be negative';
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

  select p.full_name into v_player_name from public.players p where p.id = v_enrollment.player_id;
  v_plan_type_ar := case coalesce(v_prior_plan_type, 'monthly')
    when 'monthly' then 'شهري'
    when 'quarterly' then 'ربع سنوي'
    when 'season' then 'موسم'
    when 'package' then 'باقة'
    else coalesce(v_prior_plan_type, 'monthly')
  end;
  v_description := 'تجديد اشتراك ' || v_plan_type_ar
    || case when v_player_name is not null then ' — ' || v_player_name else '' end
    || case when v_group_name is not null then ' — ' || v_group_name else '' end;

  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, v_description, 'subscription', p_enrollment_id, 1, p_price, v_net_price);

  -- AC1 fix: preserve the enrollment's actual prior plan_type instead
  -- of hardcoding 'monthly'. Falls back to 'monthly' only when this
  -- is genuinely the FIRST subscription for the enrollment (no prior
  -- row exists) -- matches the same coalesce-to-monthly default
  -- already used for the Arabic description label above.
  insert into public.subscriptions (club_id, enrollment_id, plan_type, start_date, end_date, price, discount, status, invoice_id, created_by)
  values (v_club_id, p_enrollment_id, coalesce(v_prior_plan_type, 'monthly'), p_start_date, p_end_date, p_price, p_discount, 'pending', v_invoice_id, auth.uid())
  returning id into v_subscription_id;

  perform public.write_audit_log(
    v_club_id, 'subscription.renew', 'subscription', v_subscription_id, null,
    jsonb_build_object('enrollment_id', p_enrollment_id, 'start_date', p_start_date, 'end_date', p_end_date, 'price', p_price),
    null
  );

  return query select v_subscription_id, v_invoice_id;
end;
$function$;

-- ---------------------------------------------------------------
-- AC2 (continued): create_enrollment_with_subscription -- same
-- negative-discount rejection, added before its own greatest(...)
-- computation. Everything else byte-identical to the live body.
-- ---------------------------------------------------------------
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
  v_player_name text;
  v_plan_type_ar text;
  v_description text;
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

  -- AC2 fix: reject a negative discount before it can inflate the
  -- price or reach any insert -- matches renew_academy_subscription's
  -- identical fix above and the booking-side D5 precedent exactly.
  if p_discount < 0 then
    raise exception 'discount amount cannot be negative';
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

  select p.full_name into v_player_name from public.players p where p.id = p_player_id;
  v_plan_type_ar := case p_plan_type
    when 'monthly' then 'شهري'
    when 'quarterly' then 'ربع سنوي'
    when 'season' then 'موسم'
    when 'package' then 'باقة'
    else p_plan_type
  end;
  v_description := 'اشتراك ' || v_plan_type_ar
    || case when v_player_name is not null then ' — ' || v_player_name else '' end
    || case when v_group.name is not null then ' — ' || v_group.name else '' end;

  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, v_description, 'subscription', v_enrollment_id, 1, p_price, v_net_price);

  insert into public.subscriptions (club_id, enrollment_id, plan_type, start_date, end_date, price, discount, status, invoice_id, created_by)
  values (v_club_id, v_enrollment_id, p_plan_type, p_start_date, p_end_date, p_price, p_discount, 'pending', v_invoice_id, auth.uid())
  returning id into v_subscription_id;

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

-- ---------------------------------------------------------------
-- AC3: unfreeze_subscription -- add the missing branch-access check,
-- resolved via the same enrollments -> groups chain every sibling
-- Academy subscription RPC already uses.
-- ---------------------------------------------------------------
create or replace function public.unfreeze_subscription(p_subscription_id uuid, p_reason text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_sub record;
  v_branch_id uuid;
  v_open_freeze record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_sub
  from public.subscriptions
  where id = p_subscription_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('subscription.freeze.create', club_id)
  for update;

  if v_sub.id is null then
    raise exception 'subscription not found or you do not have permission to unfreeze it';
  end if;

  -- AC3 fix: branch-scope check, matching freeze_subscription's own
  -- enrollments -> groups -> branch_id resolution exactly.
  select g.branch_id into v_branch_id
  from public.enrollments e
  join public.groups g on g.id = e.group_id
  where e.id = v_sub.enrollment_id;

  if not public.user_has_branch_access(v_sub.club_id, v_branch_id) then
    raise exception 'you do not have access to this branch';
  end if;

  if v_sub.status != 'frozen' then
    raise exception 'subscription is not currently frozen';
  end if;

  select * into v_open_freeze from public.subscription_freezes
  where subscription_id = p_subscription_id and end_date >= current_date
  order by start_date desc
  limit 1
  for update;

  if v_open_freeze.id is not null and v_open_freeze.end_date > current_date then
    if v_open_freeze.start_date > current_date then
      delete from public.subscription_freezes where id = v_open_freeze.id;
    else
      update public.subscription_freezes set end_date = current_date where id = v_open_freeze.id;
    end if;
  end if;

  perform set_config('app.allow_subscription_status_transition', 'true', true);
  update public.subscriptions set status = 'active' where id = p_subscription_id;

  perform public.write_audit_log(
    v_sub.club_id, 'subscription.unfreeze', 'subscription', p_subscription_id, null,
    jsonb_build_object('ended_freeze_id', v_open_freeze.id),
    p_reason
  );
end;
$function$;

-- ---------------------------------------------------------------
-- AC4: update_academy_membership -- add the missing branch-access
-- check (this RPC edits a `groups` row, branded "Membership" in the
-- UI). groups already has its own branch_id column directly, so no
-- join is needed, unlike the subscription RPCs above.
-- ---------------------------------------------------------------
create or replace function public.update_academy_membership(p_group_id uuid, p_name text, p_capacity integer, p_subscription_price numeric, p_status text, p_reason text DEFAULT NULL::text)
 returns groups
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_before public.groups;
  v_after public.groups;
begin
  select * into v_before
  from public.groups
  where id = p_group_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('academy.program.manage', club_id)
  for update;

  if v_before.id is null then raise exception 'ACADEMY_MEMBERSHIP_NOT_FOUND_OR_NOT_AUTHORIZED'; end if;

  -- AC4 fix: branch-scope check, same pattern as every other Academy
  -- write RPC -- groups has its own branch_id, no join needed.
  if not public.user_has_branch_access(v_before.club_id, v_before.branch_id) then
    raise exception 'you do not have access to this branch';
  end if;

  if nullif(btrim(p_name), '') is null then raise exception 'MEMBERSHIP_NAME_REQUIRED'; end if;
  if p_capacity < 1 then raise exception 'MEMBERSHIP_CAPACITY_INVALID'; end if;
  if p_subscription_price is null or p_subscription_price < 0 then
    raise exception 'MEMBERSHIP_PRICE_INVALID';
  end if;
  if p_status not in ('active', 'closed') then raise exception 'MEMBERSHIP_STATUS_INVALID'; end if;

  update public.groups
  set name = btrim(p_name), capacity = p_capacity,
      subscription_price = p_subscription_price, status = p_status
  where id = p_group_id
  returning * into v_after;

  perform public.write_audit_log(v_before.club_id, 'academy_membership.updated',
    'academy_membership', v_before.id, to_jsonb(v_before), to_jsonb(v_after),
    nullif(btrim(p_reason), ''));
  return v_after;
end;
$function$;

-- ---------------------------------------------------------------
-- AC5: expire_due_academy_subscriptions -- use club-local "today"
-- (per-club, via each subscription's own club's timezone) instead of
-- server/UTC current_date, AND use the freeze-aware effective end
-- date instead of the raw end_date column, so a subscription that was
-- frozen-then-unfrozen with extends_expiry=true is no longer expired
-- on its pre-extension date.
-- ---------------------------------------------------------------
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

  -- AC5 fix: join clubs for each subscription's own IANA timezone
  -- (never a single global "today" -- different clubs can be in
  -- different zones), and compare against the freeze-aware EFFECTIVE
  -- end date rather than the raw end_date column, so an unfrozen
  -- subscription's freeze-extended expiry is honored instead of
  -- silently ignored.
  --
  -- Deliberately does NOT call get_subscription_effective_end_date()
  -- here -- that function is permission-gated
  -- (has_permission('subscription.view', ...) against
  -- user_club_ids(), which resolves via auth.uid()). This function
  -- runs as a pg_cron job with NO authenticated caller (auth.uid() IS
  -- NULL in that context), so calling the gated wrapper would have
  -- silently returned NULL for every single row, breaking the entire
  -- sweep. The freeze-sum math is inlined instead, computing the same
  -- effective end date directly.
  with expired as (
    update public.subscriptions s
    set status = 'expired'
    from public.clubs c
    where s.club_id = c.id
      and s.status in ('active', 'pending')
      and (s.end_date + coalesce(
        (select sum(f.end_date - f.start_date)::int from public.subscription_freezes f
         where f.subscription_id = s.id and f.extends_expiry = true),
        0
      )) < (now() at time zone coalesce(c.timezone, 'UTC'))::date
    returning s.id, s.club_id
  )
  select count(*), array_agg(id), array_agg(distinct club_id)
    into v_count, v_expired_ids, v_club_ids
  from expired;

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

-- AC6 note: get_academy_subscription_display_status() (the SQL RPC)
-- was investigated and found to be effectively DEAD CODE from the
-- runtime's perspective -- confirmed via `select proname from pg_proc
-- where prosrc ilike '%get_academy_subscription_display_status%' and
-- proname != 'get_academy_subscription_display_status'` returning
-- zero rows (no other server function calls it), and the frontend
-- never calls this RPC directly either -- it only mirrors the same
-- rule in a pure TypeScript function (src/lib/domain/academy.ts,
-- getAcademySubscriptionDisplayStatus), which IS the function
-- actually in the live rendering path (EnrollmentSection.tsx). Left
-- this unused SQL function untouched (no orphaned-overload risk,
-- nothing depends on its signature) and fixed the REAL bug at its
-- real location instead -- see the accompanying frontend commit to
-- src/lib/domain/academy.ts.

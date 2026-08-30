-- PRINTING PRODUCTION ACCEPTANCE (2026-08-30), Section 6 (invoice line
-- items must be meaningful, not a raw enum leak): a subagent's live
-- discovery sweep found create_enrollment_with_subscription() builds
-- invoice_items.description as `'اشتراك ' || p_plan_type`, where
-- p_plan_type is the RAW, UNTRANSLATED enum value ('monthly',
-- 'quarterly', 'season', or 'package') -- confirmed live: a real
-- printed academy invoice shows the line item "اشتراك monthly",
-- mixing an English database enum directly into an Arabic sentence.
-- No player name or group name is included either, so a guardian
-- with two children in the same club sees identical, indistinguishable
-- line items on both invoices.
--
-- Fix: translate p_plan_type to real Arabic ("شهري"/"ربع سنوي"/
-- "موسم"/"باقة" -- covers exactly the 4 values the
-- subscriptions_plan_type_check constraint allows, confirmed via
-- pg_get_constraintdef), and include the player's name and the
-- group's name, so the printed invoice line item is actually
-- meaningful and distinguishes between multiple children/enrollments.
--
-- Same fix applied to renew_academy_subscription(), which had its own
-- version of this same class of problem: description hardcoded to the
-- Arabic string 'تجديد اشتراك شهري' ("renewal of MONTHLY subscription")
-- regardless of the enrollment's actual plan type -- confirmed live
-- via source read this migration is correcting alongside the sibling
-- RPC. NOTE (documented, not fixed in this pass -- printing-directive
-- scope, not financial-semantics scope): renew_academy_subscription()
-- ALSO hardcodes the new subscription row's plan_type column itself to
-- 'monthly', not the original enrollment's real plan type -- a
-- separate, real accounting-semantics defect this printing fix
-- surfaced but does not itself correct (renewing a quarterly/season/
-- package subscriber's plan silently becomes 'monthly' in the
-- subscriptions table, not just on the printed description). Flagged
-- in PRINTING_PRODUCTION_ACCEPTANCE_PLAN.md for a dedicated pass;
-- fixing plan_type itself would touch active subscription-lifecycle
-- semantics, which is out of scope for "only reopen a closed domain
-- when a printing test reveals a concrete underlying defect" applied
-- narrowly to what this printing pass actually needs (the printed
-- description text).
create or replace function public.create_enrollment_with_subscription(p_player_id uuid, p_group_id uuid, p_guardian_id uuid, p_plan_type text, p_start_date date, p_end_date date, p_price numeric, p_discount numeric DEFAULT 0)
 returns table(enrollment_id uuid, subscription_id uuid, invoice_id uuid)
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

create or replace function public.renew_academy_subscription(p_enrollment_id uuid, p_start_date date, p_end_date date, p_price numeric, p_discount numeric DEFAULT 0)
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
  -- PRINTING-SCOPE FIX ONLY: the description now reflects the prior
  -- subscription's real plan type (falls back to 'monthly' only when
  -- there is no prior subscription to read from, matching the
  -- function's pre-existing behavior for that edge case). The
  -- subscriptions.plan_type COLUMN itself is intentionally left
  -- exactly as it was (still hardcoded to 'monthly' below) -- see this
  -- migration's header for why fixing that is out of scope here.
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

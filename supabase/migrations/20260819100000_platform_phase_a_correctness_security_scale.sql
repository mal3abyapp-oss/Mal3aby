-- Platform Owner directive, Phase A: P1 correctness / security / scalability.
--
-- A1. Dead Grace Period setting: platform_settings.default_grace_period_days
--     was editable in Platform Settings UI but read by NO subscription logic
--     (trials hardcode grace=0; paid/complimentary use platform_plans.default_grace_period_days,
--     the per-plan value). Confirmed via full migration grep during the live
--     audit. Source of truth is per-plan, which is already correct and already
--     used everywhere. Drop the dead global column so Settings cannot mislead
--     a platform owner into believing it does something.
--
-- A2. Trial abuse: create_platform_subscription's manual trial path never
--     checked automatic_trial_entitlements (the real per-owner trial guard),
--     only one_trial_per_club (per-club, not per-owner) stopped it. A real
--     owner could create serial new clubs and get unlimited manual trials.
--     Fix: manual trial creation now checks the same entitlement table the
--     automatic (onboarding) trial path uses, keyed by user_id OR normalized
--     mobile/email snapshot (catches the same person signing up as a
--     "different" auth user with the same phone/email). Platform owner can
--     still force a trial past this check with p_force_override=true, but
--     it requires a reason and is always audit-logged distinctly so an
--     override is never silent.
--
-- A3. N+1 platform access lookups: Overview and Clubs List called
--     get_club_platform_access() once per club via Promise.all. Add a
--     batched RPC returning access state for many clubs in one round-trip.
--
-- A4-A7. Audit coverage: create_platform_subscription, record_platform_payment,
--     renew_platform_subscription never called write_audit_log. Add audit
--     logging to all three so every material platform financial/subscription
--     action is traceable (actor already exists as audit_logs.actor_id --
--     this migration doesn't touch that column, only fixes callers that
--     skipped logging entirely).

begin;

-- ============================================================
-- A1: remove the dead global grace-period setting
-- ============================================================
alter table public.platform_settings drop column if exists default_grace_period_days;

-- ============================================================
-- A2: trial eligibility helper -- single source of truth used by
--     both the automatic (onboarding) and manual (platform owner) paths
-- ============================================================
create or replace function public.check_trial_eligibility(
  p_user_id uuid,
  p_normalized_mobile text,
  p_email text
)
returns table(eligible boolean, blocking_reason text)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_existing record;
begin
  select * into v_existing
  from public.automatic_trial_entitlements
  where user_id = p_user_id
     or (p_normalized_mobile is not null and owner_normalized_mobile_snapshot = p_normalized_mobile)
     or (p_email is not null and lower(owner_email_snapshot) = lower(p_email))
  limit 1;

  if v_existing is null then
    return query select true, null::text;
  else
    return query select false, 'trial already consumed by this owner (user_id, mobile, or email match)';
  end if;
end;
$function$;

revoke all on function public.check_trial_eligibility(uuid, text, text) from public;
revoke all on function public.check_trial_eligibility(uuid, text, text) from anon;
grant execute on function public.check_trial_eligibility(uuid, text, text) to authenticated;

-- ============================================================
-- A2 (cont'd) + A4/A7: create_platform_subscription -- add trial
--     eligibility check + override + audit logging (all kinds, not
--     just trial)
-- ============================================================
create or replace function public.create_platform_subscription(
  p_club_id uuid,
  p_subscription_kind text,
  p_plan_id uuid default null,
  p_trial_origin text default null,
  p_force_override boolean default false,
  p_override_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_settings record;
  v_plan record;
  v_start timestamptz := now();
  v_end timestamptz;
  v_grace_days int;
  v_subscription_id uuid;
  v_invoice_number bigint;
  v_club record;
  v_owner_membership record;
  v_owner_email text;
  v_owner_mobile text;
  v_eligibility record;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if p_subscription_kind not in ('trial', 'paid', 'complimentary') then
    raise exception 'invalid subscription_kind';
  end if;

  select * into v_club from public.clubs where id = p_club_id;
  if v_club is null then
    raise exception 'club not found';
  end if;

  select * into v_settings from public.platform_settings where id = true;

  if p_subscription_kind = 'trial' then
    -- A2: real per-owner trial-abuse guard, using the same entitlement
    -- table the automatic onboarding trial already enforces. Resolve the
    -- club's owner (club_owner membership) to check against.
    select cm.user_id, u.email, p.phone
      into v_owner_membership
    from public.club_memberships cm
    join public.roles r on r.id = cm.role_id and r.key = 'club_owner'
    left join auth.users u on u.id = cm.user_id
    left join public.profiles p on p.user_id = cm.user_id
    where cm.club_id = p_club_id and cm.status = 'active'
    order by cm.created_at asc
    limit 1;

    v_owner_email := v_owner_membership.email;
    v_owner_mobile := public.normalize_mobile(v_owner_membership.phone);

    select * into v_eligibility from public.check_trial_eligibility(
      v_owner_membership.user_id, v_owner_mobile, v_owner_email
    );

    if not v_eligibility.eligible and not p_force_override then
      raise exception 'trial not eligible: % (pass p_force_override=true with a reason to proceed anyway)', v_eligibility.blocking_reason;
    end if;

    if not v_eligibility.eligible and p_force_override then
      if p_override_reason is null or length(trim(p_override_reason)) = 0 then
        raise exception 'a reason is required to override trial eligibility';
      end if;
    end if;

    v_end := v_start + (v_settings.default_trial_days || ' days')::interval;
    v_grace_days := 0;

    insert into public.platform_subscriptions
      (club_id, plan_id, subscription_kind, trial_origin, plan_name_snapshot,
       price_snapshot, currency_snapshot, interval_snapshot, interval_count_snapshot,
       grace_period_days_snapshot, start_at, end_at, lifecycle_status)
    values
      (p_club_id, null, 'trial', coalesce(p_trial_origin, 'manual'), 'تجربة مجانية',
       0, 'EGP', null, null,
       0, v_start, v_end, 'trial')
    returning id into v_subscription_id;

    perform public.write_audit_log(
      p_club_id,
      case when not v_eligibility.eligible then 'create_platform_subscription_trial_override' else 'create_platform_subscription_trial' end,
      'platform_subscriptions', v_subscription_id,
      null,
      jsonb_build_object('subscription_kind', 'trial', 'trial_origin', coalesce(p_trial_origin, 'manual'), 'end_at', v_end),
      case when not v_eligibility.eligible then p_override_reason else null end
    );

    return v_subscription_id;
  end if;

  if p_plan_id is null then
    raise exception 'plan_id is required for paid/complimentary subscriptions';
  end if;

  select * into v_plan from public.platform_plans where id = p_plan_id and status = 'active';
  if v_plan is null then
    raise exception 'plan not found or inactive';
  end if;

  v_end := v_start + (v_plan.billing_interval_count || ' ' || v_plan.billing_interval)::interval;
  v_grace_days := v_plan.default_grace_period_days;

  insert into public.platform_subscriptions
    (club_id, plan_id, subscription_kind, trial_origin, plan_name_snapshot,
     price_snapshot, currency_snapshot, interval_snapshot, interval_count_snapshot,
     grace_period_days_snapshot, start_at, end_at, lifecycle_status)
  values
    (p_club_id, v_plan.id, p_subscription_kind, null, v_plan.name_ar,
     case when p_subscription_kind = 'complimentary' then 0 else v_plan.price end,
     v_plan.currency, v_plan.billing_interval, v_plan.billing_interval_count,
     v_grace_days, v_start, v_end, 'active')
  returning id into v_subscription_id;

  if p_subscription_kind = 'paid' then
    v_invoice_number := nextval('public.platform_invoice_number_seq');
    insert into public.platform_invoices
      (club_id, platform_subscription_id, invoice_number, amount, due_date, status)
    values
      (p_club_id, v_subscription_id, v_invoice_number, v_plan.price, v_start::date, 'pending');
  end if;

  perform public.write_audit_log(
    p_club_id, 'create_platform_subscription', 'platform_subscriptions', v_subscription_id,
    null,
    jsonb_build_object('subscription_kind', p_subscription_kind, 'plan', v_plan.name_ar, 'price', v_plan.price),
    null
  );

  return v_subscription_id;
end;
$function$;

revoke all on function public.create_platform_subscription(uuid, text, uuid, text, boolean, text) from public;
revoke all on function public.create_platform_subscription(uuid, text, uuid, text, boolean, text) from anon;
grant execute on function public.create_platform_subscription(uuid, text, uuid, text, boolean, text) to authenticated;

-- Drop the old 4-arg signature now superseded by the 6-arg version above
-- (frontend will be updated to call the new signature; old signature had
-- no override capability and is being fully replaced, not overloaded, to
-- avoid two divergent code paths for the same action).
drop function if exists public.create_platform_subscription(uuid, text, uuid, text);

-- ============================================================
-- A7: record_platform_payment -- add audit logging
-- ============================================================
create or replace function public.record_platform_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_method text,
  p_reference text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_payment_id uuid;
  v_club_id uuid;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  if p_method not in ('bank_transfer', 'cash', 'other') then
    raise exception 'invalid method';
  end if;

  select club_id into v_club_id from public.platform_invoices where id = p_invoice_id;
  if v_club_id is null then
    raise exception 'invoice not found';
  end if;

  insert into public.platform_payments (platform_invoice_id, amount, method, reference, recorded_by)
  values (p_invoice_id, p_amount, p_method, p_reference, auth.uid())
  returning id into v_payment_id;

  update public.platform_invoices set status = 'paid' where id = p_invoice_id;

  perform public.write_audit_log(
    v_club_id, 'record_platform_payment', 'platform_payments', v_payment_id,
    null,
    jsonb_build_object('amount', p_amount, 'method', p_method, 'reference', p_reference, 'invoice_id', p_invoice_id),
    null
  );

  return v_payment_id;
end;
$function$;

revoke all on function public.record_platform_payment(uuid, numeric, text, text) from public;
revoke all on function public.record_platform_payment(uuid, numeric, text, text) from anon;
grant execute on function public.record_platform_payment(uuid, numeric, text, text) to authenticated;

-- ============================================================
-- A7: renew_platform_subscription -- add audit logging
-- ============================================================
create or replace function public.renew_platform_subscription(
  p_previous_subscription_id uuid,
  p_plan_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_prev record;
  v_plan record;
  v_start timestamptz;
  v_end timestamptz;
  v_subscription_id uuid;
  v_invoice_number bigint;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  select * into v_prev from public.platform_subscriptions where id = p_previous_subscription_id;
  if v_prev is null then
    raise exception 'previous subscription not found';
  end if;

  select * into v_plan from public.platform_plans
    where id = coalesce(p_plan_id, v_prev.plan_id) and status = 'active';
  if v_plan is null then
    raise exception 'plan not found or inactive';
  end if;

  v_start := greatest(v_prev.end_at, now());
  v_end := v_start + (v_plan.billing_interval_count || ' ' || v_plan.billing_interval)::interval;

  insert into public.platform_subscriptions
    (club_id, plan_id, subscription_kind, trial_origin, plan_name_snapshot,
     price_snapshot, currency_snapshot, interval_snapshot, interval_count_snapshot,
     grace_period_days_snapshot, start_at, end_at, previous_subscription_id, lifecycle_status)
  values
    (v_prev.club_id, v_plan.id, 'paid', null, v_plan.name_ar,
     v_plan.price, v_plan.currency, v_plan.billing_interval, v_plan.billing_interval_count,
     v_plan.default_grace_period_days, v_start, v_end, v_prev.id, 'active')
  returning id into v_subscription_id;

  v_invoice_number := nextval('public.platform_invoice_number_seq');
  insert into public.platform_invoices
    (club_id, platform_subscription_id, invoice_number, amount, due_date, status)
  values
    (v_prev.club_id, v_subscription_id, v_invoice_number, v_plan.price, v_start::date, 'pending');

  perform public.write_audit_log(
    v_prev.club_id, 'renew_platform_subscription', 'platform_subscriptions', v_subscription_id,
    jsonb_build_object('previous_subscription_id', v_prev.id),
    jsonb_build_object('plan', v_plan.name_ar, 'start_at', v_start, 'end_at', v_end),
    null
  );

  return v_subscription_id;
end;
$function$;

revoke all on function public.renew_platform_subscription(uuid, uuid) from public;
revoke all on function public.renew_platform_subscription(uuid, uuid) from anon;
grant execute on function public.renew_platform_subscription(uuid, uuid) to authenticated;

-- ============================================================
-- A3: batched platform club-access lookup -- replaces N+1
--     get_club_platform_access() calls on Overview/Clubs List.
--     Returns access + a machine-readable reason so the frontend
--     can label "no subscription" distinctly from "grace expired"
--     (also closes part of B4/orphaned-club visibility, since the
--     reason is now available wherever access is queried).
-- ============================================================
create or replace function public.get_platform_clubs_access(p_club_ids uuid[])
returns table(club_id uuid, access text, reason text)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  return query
  with target_clubs as (
    select c.id, c.status
    from public.clubs c
    where c.id = any(p_club_ids)
  ),
  latest_sub as (
    select distinct on (ps.club_id)
      ps.club_id, ps.end_at, ps.grace_period_days_snapshot, ps.lifecycle_status
    from public.platform_subscriptions ps
    where ps.club_id = any(p_club_ids) and ps.lifecycle_status != 'cancelled'
    order by ps.club_id, ps.start_at desc
  )
  select
    tc.id as club_id,
    case
      when tc.status in ('suspended', 'closed') then 'blocked'
      when ls.club_id is null then 'blocked'
      when now() < ls.end_at then 'full'
      when now() < ls.end_at + (ls.grace_period_days_snapshot || ' days')::interval then 'grace'
      else 'blocked'
    end as access,
    case
      when tc.status in ('suspended', 'closed') then 'admin_suspended'
      when ls.club_id is null then 'no_subscription'
      when now() < ls.end_at then 'active'
      when now() < ls.end_at + (ls.grace_period_days_snapshot || ' days')::interval then 'in_grace'
      else 'expired'
    end as reason
  from target_clubs tc
  left join latest_sub ls on ls.club_id = tc.id;
end;
$function$;

revoke all on function public.get_platform_clubs_access(uuid[]) from public;
revoke all on function public.get_platform_clubs_access(uuid[]) from anon;
grant execute on function public.get_platform_clubs_access(uuid[]) to authenticated;

commit;

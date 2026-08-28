-- PLATFORM OWNER CONTROL IMPLEMENTATION -- Phase 4 (P1).
-- PLATFORM_OWNER_COMPLETE_CONTROL_AUDIT.md finding: platform_plans has
-- zero mechanical connection to club_modules/commercial_entitlements --
-- a plan is pure pricing/term metadata. Two clubs on the identical plan
-- can silently diverge in actual entitlements/limits, and a Platform
-- Owner selling a plan must remember, entirely manually, to separately
-- configure the club's modules and limits.
--
-- Fix, deliberately conservative per the implementation plan's own
-- scope decision: add OPTIONAL, NULLABLE default columns to
-- platform_plans (a plan MAY define defaults; an unset plan behaves
-- exactly as today). Wire them into create_platform_subscription() as a
-- SEED, never an overwrite -- only applied when the club has no
-- existing club_modules row for a given key / no existing
-- commercial_entitlements row at all. Every existing club today already
-- has all 4 club_modules rows (backfilled in two prior phases) and most
-- have no commercial_entitlements row (NULL = unlimited, the
-- long-standing default) -- so this migration changes behavior for
-- ZERO existing clubs; it only takes effect the next time a NEW
-- subscription is created for a club that doesn't yet have that
-- specific configuration.

-- Step 1: optional plan defaults. NULL array/values = "this plan
-- defines no defaults", the same semantics NULL already has on
-- commercial_entitlements' own limit columns.
alter table public.platform_plans
  add column if not exists default_modules text[],
  add column if not exists default_branch_limit integer,
  add column if not exists default_field_limit integer,
  add column if not exists default_academy_limit integer;

comment on column public.platform_plans.default_modules is
  'Optional: module_key values this plan grants by default (e.g. {fields,academy,shop}) when a NEW subscription is created for a club with no existing club_modules row for that key. NULL/empty = no defaults defined; never overwrites an existing club_modules row.';
comment on column public.platform_plans.default_branch_limit is
  'Optional: seeded onto a NEW club''s commercial_entitlements.branch_limit only if that club has no commercial_entitlements row at all yet. NULL = plan defines no default (existing NULL = unlimited semantics unaffected).';
comment on column public.platform_plans.default_field_limit is
  'Optional: same seeding semantics as default_branch_limit, for field_limit.';
comment on column public.platform_plans.default_academy_limit is
  'Optional: same seeding semantics as default_branch_limit, for academy_limit.';

-- Step 2: wire the seed into create_platform_subscription(), in the
-- paid/complimentary branch only (trials intentionally keep their
-- existing, unrelated behavior -- v_plan is null for the trial branch,
-- which returns early above this point, so no plan defaults could ever
-- apply to a trial regardless). Body otherwise byte-identical to the
-- current live definition
-- (20260819100000_platform_phase_a_correctness_security_scale.sql).
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
  v_seed_module text;
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

  -- PLATFORM OWNER CONTROL IMPLEMENTATION -- Phase 4: seed-only plan
  -- defaults, never an overwrite. club_modules: only inserted for a
  -- module_key this club has no row for yet (ON CONFLICT DO NOTHING --
  -- every real club today already has all 4 rows via the two prior
  -- backfills, so this is a true no-op for all existing clubs and only
  -- matters for a genuinely new club/module pairing in the future).
  if v_plan.default_modules is not null then
    foreach v_seed_module in array v_plan.default_modules loop
      if v_seed_module in ('fields', 'academy', 'shop', 'club_membership') then
        insert into public.club_modules (club_id, module_key, entitled, active)
        values (p_club_id, v_seed_module, true, true)
        on conflict (club_id, module_key) do nothing;
      end if;
    end loop;
  end if;

  -- commercial_entitlements: only inserted if the club has NO row at
  -- all yet (ON CONFLICT DO NOTHING on the primary key) -- never
  -- touches a club's existing limits, even to fill in a single NULL
  -- column, since "this club already has entitlements configured" is
  -- itself information the Platform Owner may have set deliberately.
  if v_plan.default_branch_limit is not null or v_plan.default_field_limit is not null or v_plan.default_academy_limit is not null then
    insert into public.commercial_entitlements (club_id, branch_limit, field_limit, academy_limit)
    values (p_club_id, v_plan.default_branch_limit, v_plan.default_field_limit, v_plan.default_academy_limit)
    on conflict (club_id) do nothing;
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

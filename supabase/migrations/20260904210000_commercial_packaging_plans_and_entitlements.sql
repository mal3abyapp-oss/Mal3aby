-- MAL3ABY V1 COMMERCIAL PACKAGING -- Step 1: new Starter/Growth/Pro plan
-- rows (monthly + annual = 6 new platform_plans rows) and legacy plan
-- archival.
--
-- SAFETY-CRITICAL FINDING (documented per mission instruction): the
-- originating mission brief claimed "ZERO platform_subscriptions rows
-- reference any of the 4 legacy plan IDs." This was independently
-- verified FALSE by two separate read-only agent passes against
-- production before this migration was written:
--
--   Monthly   (d1a05e72-1d91-418a-a943-55b1deb2328e): 4 referencing rows
--              (3 active+paid, 1 cancelled+paid)
--   Quarterly (2ffe755e-bf96-4341-993d-f33d75c8076c): 0 referencing rows
--   Semi-Annual (21988a54-0bda-433c-8e3d-d0d92b4756e9): 0 referencing rows
--   Annual    (21c0c577-2596-4809-a932-5092685f6161): 1 referencing row
--              (active+complimentary)
--
-- All 5 referencing clubs have clubs.is_test_fixture = true (Arabic
-- names literally reading as test/verification clubs). None are real
-- paying customers. Per the mission's own explicit rule ("if you find
-- ANY subscription referencing a legacy plan... STOP that specific
-- migration step, do not archive that plan, surface it explicitly, and
-- continue everything else"), this migration applies that rule
-- literally and conservatively -- it does NOT treat "the reference is
-- only a test fixture" as license to archive anyway:
--
--   Quarterly, Semi-Annual -> ARCHIVED (is_public = false) -- zero
--     references, safe per both the mission's rule and independent
--     verification.
--   Monthly, Annual -> NOT ARCHIVED, remain is_public = true -- live
--     references exist. Full detail and remediation path in
--     MAL3ABY_V1_PRICING_MIGRATION.md.
--
-- This is non-destructive regardless: platform_subscriptions snapshots
-- price/interval/currency/grace at creation time (price_snapshot etc.),
-- so is_public=false never alters any existing subscription's terms --
-- it only stops the plan being offered for NEW signups. No plan row is
-- ever deleted.

-- ============================================================
-- Archive Quarterly and Semi-Annual only (zero live references,
-- independently confirmed).
-- ============================================================
update public.platform_plans
set is_public = false
where id in (
  '2ffe755e-bf96-4341-993d-f33d75c8076c', -- Quarterly
  '21988a54-0bda-433c-8e3d-d0d92b4756e9'  -- Semi-Annual
);

-- ============================================================
-- New commercial tiers: Starter / Growth / Pro, each as two rows
-- (monthly + annual) sharing a name so the frontend can group them as
-- one commercial plan with a billing-interval toggle. Enterprise is
-- deliberately NOT a platform_plans row (custom/contract-defined terms,
-- represented instead via subscription_kind='complimentary' or a future
-- dedicated contract table -- out of scope here, matches the mission's
-- own "Enterprise = Custom price, contract-defined limits" framing).
--
-- Annual pricing math (~15% discount target, exact figures documented
-- in MAL3ABY_V1_COMMERCIAL_PACKAGING.md):
--   Starter: 1790*12=21480, 15% off=18258.00 -> clean 18000 (16.20% off)
--   Growth:  2990*12=35880, 15% off=30498.00 -> clean 30000 (16.39% off)
--   Pro:     4990*12=59880, 15% off=50898.00 -> clean 50000 (16.50% off)
--
-- default_grace_period_days = 7 on all 6 (matches the mission's default
-- grace duration decision, reused directly from the existing
-- platform_plans.default_grace_period_days column rather than a new
-- convention).
-- ============================================================
insert into public.platform_plans (
  id, name, name_ar, description_ar, billing_interval, billing_interval_count,
  price, currency, discount_label, features_summary, default_grace_period_days,
  is_public, display_order, status,
  default_modules, default_branch_limit, default_field_limit, default_academy_limit
) values
  -- Starter
  (gen_random_uuid(), 'Starter', 'الأساسية',
   'فرع واحد، 3 ملاعب، أكاديمية واحدة -- مثالية للأندية الناشئة',
   'month', 1, 1790.00, 'EGP', null,
   'حجوزات غير محدودة، تقارير كاملة، واتساب ضمن سياسة الاستخدام العادل، دعم قياسي',
   7, true, 10, 'active',
   array['fields','academy','club_membership'], 1, 3, 1),
  (gen_random_uuid(), 'Starter (Annual)', 'الأساسية (سنوي)',
   'فرع واحد، 3 ملاعب، أكاديمية واحدة -- خصم سنوي 16.2%',
   'year', 1, 18000.00, 'EGP', 'وفّر 16.2% مع الاشتراك السنوي',
   'حجوزات غير محدودة، تقارير كاملة، واتساب ضمن سياسة الاستخدام العادل، دعم قياسي',
   7, true, 11, 'active',
   array['fields','academy','club_membership'], 1, 3, 1),
  -- Growth
  (gen_random_uuid(), 'Growth', 'النمو',
   '3 فروع، 10 ملاعب، 3 أكاديميات -- للأندية المتوسعة',
   'month', 1, 2990.00, 'EGP', null,
   'حجوزات غير محدودة، تقارير كاملة، واتساب ضمن سياسة الاستخدام العادل، دعم ذو أولوية',
   7, true, 20, 'active',
   array['fields','academy','club_membership','shop'], 3, 10, 3),
  (gen_random_uuid(), 'Growth (Annual)', 'النمو (سنوي)',
   '3 فروع، 10 ملاعب، 3 أكاديميات -- خصم سنوي 16.4%',
   'year', 1, 30000.00, 'EGP', 'وفّر 16.4% مع الاشتراك السنوي',
   'حجوزات غير محدودة، تقارير كاملة، واتساب ضمن سياسة الاستخدام العادل، دعم ذو أولوية',
   7, true, 21, 'active',
   array['fields','academy','club_membership','shop'], 3, 10, 3),
  -- Pro
  (gen_random_uuid(), 'Pro', 'الاحترافية',
   '6 فروع، 25 ملعب، 6 أكاديميات -- للأندية الكبيرة والمتعددة الفروع',
   'month', 1, 4990.00, 'EGP', null,
   'حجوزات غير محدودة، تقارير كاملة، واتساب ضمن سياسة الاستخدام العادل، دعم ذو أولوية، مساعدة في الترحيل',
   7, true, 30, 'active',
   array['fields','academy','club_membership','shop'], 6, 25, 6),
  (gen_random_uuid(), 'Pro (Annual)', 'الاحترافية (سنوي)',
   '6 فروع، 25 ملعب، 6 أكاديميات -- خصم سنوي 16.5%',
   'year', 1, 50000.00, 'EGP', 'وفّر 16.5% مع الاشتراك السنوي',
   'حجوزات غير محدودة، تقارير كاملة، واتساب ضمن سياسة الاستخدام العادل، دعم ذو أولوية، مساعدة في الترحيل',
   7, true, 31, 'active',
   array['fields','academy','club_membership','shop'], 6, 25, 6);

-- ============================================================
-- commercial_entitlements: add staff_limit / active_player_limit,
-- reusing the exact same table and NULL=unlimited convention already
-- established for branch_limit/field_limit/academy_limit. These are
-- CONTROLLED resources (grace-state, never hard-blocked at INSERT) --
-- deliberately NOT given BEFORE INSERT triggers like the other three,
-- since the mission requires warn/grace behavior, not reject-at-100%.
-- ============================================================
alter table public.commercial_entitlements
  add column if not exists staff_limit integer,
  add column if not exists active_player_limit integer,
  add column if not exists controlled_resource_grace_days integer not null default 7;

comment on column public.commercial_entitlements.staff_limit is
  'Controlled (non-blocking) resource: NULL = unlimited. Never enforced via INSERT trigger -- see get_commercial_usage() / grace-state model in 20260904210100_commercial_packaging_usage_rpcs.sql. Distinct from branch/field/academy_limit which ARE hard-enforced at INSERT.';
comment on column public.commercial_entitlements.active_player_limit is
  'Controlled (non-blocking) resource: NULL = unlimited. Measured via count_active_customers_and_players() (90-day trailing qualifying-activity definition). Never blocks writes -- grace-state only.';
comment on column public.commercial_entitlements.controlled_resource_grace_days is
  'Grace period (days) after staff_limit or active_player_limit is exceeded before a club enters OVER_LIMIT display state. Default 7, matches platform_plans.default_grace_period_days convention. Configurable per-club by Platform Owner (mirrors branch/field/academy_limit''s existing per-club override pattern).';

alter table public.platform_plans
  add column if not exists default_staff_limit integer,
  add column if not exists default_active_player_limit integer;

comment on column public.platform_plans.default_staff_limit is
  'Optional: seeded onto commercial_entitlements.staff_limit for a NEW club with no existing commercial_entitlements row, same seed-only-never-overwrite semantics as default_branch_limit.';
comment on column public.platform_plans.default_active_player_limit is
  'Optional: same seeding semantics as default_staff_limit, for active_player_limit.';

update public.platform_plans set default_staff_limit = 5, default_active_player_limit = 300
  where name_ar in ('الأساسية', 'الأساسية (سنوي)');
update public.platform_plans set default_staff_limit = 15, default_active_player_limit = 1000
  where name_ar in ('النمو', 'النمو (سنوي)');
update public.platform_plans set default_staff_limit = 40, default_active_player_limit = 3000
  where name_ar in ('الاحترافية', 'الاحترافية (سنوي)');

-- ============================================================
-- Wire the two new default columns into create_platform_subscription's
-- existing seed-only-never-overwrite commercial_entitlements insert.
-- Body is otherwise byte-identical to the previous version
-- (20260828230000_plan_entitlement_seeding.sql) -- same seeding
-- semantics extended to the two new columns, no other behavior change.
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

  if v_plan.default_modules is not null then
    foreach v_seed_module in array v_plan.default_modules loop
      if v_seed_module in ('fields', 'academy', 'shop', 'club_membership') then
        insert into public.club_modules (club_id, module_key, entitled, active)
        values (p_club_id, v_seed_module, true, true)
        on conflict (club_id, module_key) do nothing;
      end if;
    end loop;
  end if;

  if v_plan.default_branch_limit is not null or v_plan.default_field_limit is not null
     or v_plan.default_academy_limit is not null or v_plan.default_staff_limit is not null
     or v_plan.default_active_player_limit is not null then
    insert into public.commercial_entitlements (club_id, branch_limit, field_limit, academy_limit, staff_limit, active_player_limit)
    values (p_club_id, v_plan.default_branch_limit, v_plan.default_field_limit, v_plan.default_academy_limit,
            v_plan.default_staff_limit, v_plan.default_active_player_limit)
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

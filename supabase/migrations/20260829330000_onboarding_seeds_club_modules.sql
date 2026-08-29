-- P0 PRE-LAUNCH FIX (2026-08-29): self-serve trial signup created a
-- club with ZERO club_modules rows -- discovered live during a help-
-- guide QA walkthrough (fresh signup via the real onboarding UI, then
-- "add field pricing" failed with "the fields module is not active for
-- this club").
--
-- Root cause: complete_new_club_onboarding() (the RPC behind /signup's
-- 3-step wizard) inserts the club/branch/owner-membership/trial
-- subscription directly, but never inserts club_modules rows. The one
-- place that DOES seed club_modules from a plan's default_modules is
-- create_platform_subscription()'s paid/complimentary branch (see
-- 20260828230000_plan_entitlement_seeding.sql) -- the self-serve trial
-- path never calls that function at all, and this trial-shaped insert
-- in complete_new_club_onboarding() never seeded club_modules either.
--
-- Impact confirmed live: _fields_module_active()/_academy_module_active()
-- both coalesce(..., false) with no club_modules row, so a club created
-- this way could not price a field, take a booking (including the
-- public booking page), use Academy enrollment/attendance, or even
-- self-serve-activate Shop (set_club_module_active() requires an
-- existing row to update). Every club created before 2026-08-28 has 4
-- rows (an earlier backfill); the QA club created today (2026-08-29)
-- via the real UI is the only club created since then and has 0 rows --
-- confirmed via `select count(*) from club_modules group by club_id`
-- before writing this migration. No real customer has hit this yet
-- (only the QA club exists in the affected window), but the very next
-- real signup would have.
--
-- Fix: complete_new_club_onboarding() now seeds the exact same default
-- set every pre-2026-08-28 club has (fields/academy/club_membership
-- entitled+active, shop entitled+active=false -- an opt-in module the
-- owner turns on later from Settings), immediately after creating the
-- club. Idempotent backfill below covers any club already caught by
-- this gap (currently just the one QA club) using ON CONFLICT DO
-- NOTHING against the same (club_id, module_key) unique constraint
-- set_club_module_active()/create_platform_subscription() already rely
-- on.

create or replace function public.complete_new_club_onboarding(p_business_type text, p_club_name text, p_club_name_ar text, p_branch_name text, p_city text, p_phone text, p_owner_email text, p_owner_mobile text, p_government_affiliated boolean DEFAULT false, p_country text DEFAULT NULL::text, p_phone_e164 text DEFAULT NULL::text)
 returns table(club_id uuid, trial_granted boolean)
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

  -- P0 FIX: seed the same club_modules defaults every pre-2026-08-28
  -- club has (see this migration's header comment) -- without this, a
  -- freshly onboarded club cannot use Fields/Academy at all and cannot
  -- even self-serve-activate Shop.
  insert into public.club_modules (club_id, module_key, entitled, active)
  values
    (v_club_id, 'fields', true, true),
    (v_club_id, 'academy', true, true),
    (v_club_id, 'club_membership', true, true),
    (v_club_id, 'shop', true, false)
  on conflict (club_id, module_key) do nothing;

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

-- Idempotent backfill for any club already caught by this gap (a club
-- created since 2026-08-28 with zero club_modules rows). Same defaults
-- as above; ON CONFLICT DO NOTHING is a no-op for any club that already
-- has these rows.
insert into public.club_modules (club_id, module_key, entitled, active)
select c.id, m.module_key, m.entitled, m.active
from public.clubs c
cross join (values
  ('fields', true, true),
  ('academy', true, true),
  ('club_membership', true, true),
  ('shop', true, false)
) as m(module_key, entitled, active)
where not exists (select 1 from public.club_modules cm where cm.club_id = c.id)
on conflict (club_id, module_key) do nothing;

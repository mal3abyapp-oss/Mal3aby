-- P0 PRODUCTION-BREAKING FIX (2026-08-31): complete_new_club_onboarding()
-- has been throwing "column reference \"club_id\" is ambiguous" (42702)
-- on every single call since 20260829330000_onboarding_seeds_club_modules.sql
-- was deployed -- confirmed live via RLS-impersonated RPC call during a
-- Platform Owner / SaaS lifecycle acceptance pass: the call raised the
-- error and the whole transaction rolled back (0 rows inserted, no club
-- created). This means every real self-serve signup since that
-- migration landed has been completely broken (100% failure rate).
--
-- Root cause: this function's own `returns table(club_id uuid, ...)`
-- clause implicitly declares `club_id` as a PL/pgSQL variable in scope
-- for the entire function body. The P0 migration above added:
--
--   insert into public.club_modules (club_id, module_key, entitled, active)
--   values (v_club_id, 'fields', true, true), ...
--   on conflict (club_id, module_key) do nothing;
--
-- The `on conflict (club_id, module_key)` target-column-list is the one
-- place in this statement where plpgsql's identifier resolution treats
-- a bare `club_id` as ambiguous between the table column and the
-- same-named OUT-parameter variable -- even though the VALUES clause
-- correctly uses `v_club_id` and was never the problem. Reproduced in
-- isolation: the identical insert with an identically-scoped `club_id`
-- variable throws 42702 on the ON CONFLICT clause specifically;
-- resolves cleanly once `#variable_conflict use_column` is set.
--
-- Fix: add `#variable_conflict use_column` to this function only. This
-- tells plpgsql to always prefer a table column over a same-named
-- plpgsql variable when a bare identifier inside an embedded SQL
-- command is otherwise ambiguous -- the only correct reading here,
-- since ON CONFLICT's column list can never legally refer to a
-- variable in the first place. No other statement in this function
-- body is affected: every other `club_id` occurrence is either an
-- INSERT target-column-list (never variable-substituted, was never
-- ambiguous) or the `v_club_id`/`p_club_id`-prefixed local variables
-- (distinct names, no collision). Verified fix in isolation against a
-- pg_temp reproduction of the exact same statement shape before
-- applying here.
--
-- No contract change: signature, return shape, and all other behavior
-- are byte-identical to the previous (broken) version.

create or replace function public.complete_new_club_onboarding(p_business_type text, p_club_name text, p_club_name_ar text, p_branch_name text, p_city text, p_phone text, p_owner_email text, p_owner_mobile text, p_government_affiliated boolean DEFAULT false, p_country text DEFAULT NULL::text, p_phone_e164 text DEFAULT NULL::text)
 returns table(club_id uuid, trial_granted boolean)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
#variable_conflict use_column
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

  -- P0 FIX (20260829330000): seed the same club_modules defaults every
  -- pre-2026-08-28 club has -- without this, a freshly onboarded club
  -- cannot use Fields/Academy at all and cannot even self-serve-activate
  -- Shop. `#variable_conflict use_column` above fixes the ON CONFLICT
  -- ambiguity this insert triggered against the `club_id` OUT-parameter.
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

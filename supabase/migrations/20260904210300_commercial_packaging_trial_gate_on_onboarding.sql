-- MAL3ABY V1 COMMERCIAL PACKAGING -- Step 4: trial START gated on
-- onboarding-complete, not account/club creation.
--
-- Prior behavior (complete_new_club_onboarding, unchanged since
-- 20260831095910): club creation, branch creation, membership, module
-- seeding, AND trial start (insert into platform_subscriptions with
-- start_at = now()) all happened atomically in ONE RPC call -- the
-- moment a user submits the 3-step signup wizard. There was no distinct
-- "onboarding complete" event separate from "account created."
--
-- Decision (documented, since no existing separate setup-wizard
-- concept exists to reuse): introduce clubs.onboarding_completed_at as
-- the new milestone. complete_new_club_onboarding() keeps creating the
-- club/branch/membership/modules exactly as before, records the
-- automatic_trial_entitlements claim (still atomic with club creation,
-- since "did this owner already get ONE trial ever" must be decided at
-- creation time to keep the existing anti-abuse guarantee intact) --
-- but NO LONGER inserts the platform_subscriptions trial row itself.
-- Trial start moves to a new mark_club_onboarding_complete(p_club_id)
-- RPC, called once by the frontend when the owner finishes the initial
-- setup step (post-signup "let's get started" confirmation). This
-- reuses platform_subscriptions.subscription_kind='trial' and
-- lifecycle_status exactly as before -- no parallel state machine.
--
-- Backward compatibility: v_trial_granted is still returned from
-- complete_new_club_onboarding() (frontend already reads this field) --
-- it now means "this owner is ELIGIBLE for a trial, to be started once
-- onboarding completes," not "a trial has started." Frontend updated in
-- the same PR to call mark_club_onboarding_complete() as the next step
-- rather than assuming the trial is already live.

alter table public.clubs
  add column if not exists onboarding_completed_at timestamptz;

comment on column public.clubs.onboarding_completed_at is
  'Set once by mark_club_onboarding_complete(). NULL = club created but has not yet completed initial setup; trial has NOT started yet. This is the gate the mission''s Demo -> Onboarding -> 14-day trial -> Paid model requires: trial START is gated on this being non-null, not on clubs.created_at.';

-- ============================================================
-- complete_new_club_onboarding: same body as
-- 20260831095910_fix_onboarding_club_id_variable_conflict.sql (the
-- currently-live, already-P0-fixed version) with exactly one change --
-- the platform_subscriptions trial insert is REMOVED from this
-- function. v_trial_granted / trial_granted in the return value is
-- unchanged in meaning at the automatic_trial_entitlements-claim level
-- (still "did this owner get the ONE-per-owner automatic trial slot"),
-- but no longer implies a live trial subscription exists yet.
-- ============================================================
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

  -- Trial-eligibility claim still happens HERE, atomically with club
  -- creation -- this is deliberate. The one-trial-per-owner guarantee
  -- (automatic_trial_entitlements.user_id UNIQUE) must be decided at
  -- the moment a club is created, not deferred to onboarding-complete,
  -- otherwise an owner could create multiple clubs before completing
  -- onboarding on any of them and race multiple trial claims. Only the
  -- ACTUAL platform_subscriptions trial row is deferred, not the
  -- eligibility claim itself.
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

  -- REMOVED (was here in the previous version): the
  -- platform_subscriptions trial insert. Trial now starts via
  -- mark_club_onboarding_complete(), called separately once the owner
  -- finishes initial setup. v_trial_granted is still returned so the
  -- frontend knows whether to expect a trial to start.

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

-- ============================================================
-- mark_club_onboarding_complete(p_club_id): the new gate. Callable by
-- any active member of the club (the owner, typically, right after
-- signup) -- authorization mirrors user_club_ids(), not
-- is_platform_owner(), since this is a self-serve action a fresh signup
-- must be able to perform without any platform staff involvement.
-- Idempotent: calling it twice is a no-op the second time (does not
-- start a second trial, does not error).
-- ============================================================
create or replace function public.mark_club_onboarding_complete(p_club_id uuid)
returns table(onboarding_completed_at timestamptz, trial_started boolean, trial_end_at timestamptz)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club record;
  v_already_has_subscription boolean;
  v_trial_days int;
  v_start timestamptz := now();
  v_end timestamptz;
  v_entitlement record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids())) then
    raise exception 'not authorized';
  end if;

  select * into v_club from public.clubs where id = p_club_id;
  if v_club is null then
    raise exception 'club not found';
  end if;

  -- Idempotent short-circuit: already completed, return existing state
  -- without touching anything further.
  if v_club.onboarding_completed_at is not null then
    select (exists (select 1 from public.platform_subscriptions where club_id = p_club_id and subscription_kind = 'trial')) into v_already_has_subscription;
    select ps.end_at into v_end from public.platform_subscriptions ps
      where ps.club_id = p_club_id and ps.subscription_kind = 'trial' order by ps.created_at desc limit 1;
    return query select v_club.onboarding_completed_at, v_already_has_subscription, v_end;
    return;
  end if;

  update public.clubs set onboarding_completed_at = v_start where id = p_club_id;

  -- Only start a trial if this club has NO platform_subscriptions row
  -- at all yet (covers both: (a) the eligible-but-deferred case from
  -- complete_new_club_onboarding, and (b) defensively, a club a
  -- Platform Owner already manually subscribed before onboarding
  -- finished -- never overwrite an existing subscription).
  select not exists (select 1 from public.platform_subscriptions where club_id = p_club_id) into v_already_has_subscription;

  if v_already_has_subscription then
    select ate.id is not null into v_already_has_subscription
      from public.automatic_trial_entitlements ate where ate.club_id = p_club_id;

    if v_already_has_subscription then
      select default_trial_days into v_trial_days from public.platform_settings where id = true;
      v_end := v_start + (v_trial_days || ' days')::interval;

      insert into public.platform_subscriptions (
        club_id, subscription_kind, trial_origin, plan_name_snapshot, price_snapshot,
        grace_period_days_snapshot, start_at, end_at, lifecycle_status
      ) values (
        p_club_id, 'trial', 'automatic', 'تجربة مجانية', 0,
        0, v_start, v_end, 'trial'
      );

      perform public.write_audit_log(
        p_club_id, 'club.onboarding_completed_trial_started', 'clubs', p_club_id,
        null, jsonb_build_object('trial_end_at', v_end), null
      );

      return query select v_start, true, v_end;
      return;
    end if;
  end if;

  perform public.write_audit_log(
    p_club_id, 'club.onboarding_completed', 'clubs', p_club_id,
    null, jsonb_build_object('trial_started', false), null
  );

  return query select v_start, false, null::timestamptz;
end;
$$;

revoke all on function public.mark_club_onboarding_complete(uuid) from public, anon;
grant execute on function public.mark_club_onboarding_complete(uuid) to authenticated;

comment on function public.mark_club_onboarding_complete(uuid) is
  'The trial-start gate required by the mission''s Demo -> Onboarding -> 14-day trial -> Paid model. Idempotent. Only starts a trial if the club has zero platform_subscriptions rows AND holds an automatic_trial_entitlements claim (set atomically at club creation by complete_new_club_onboarding). A club a Platform Owner has already manually subscribed (paid/complimentary/trial) before onboarding completes is never overwritten.';

-- MASTER OPERATIONAL SIMPLIFICATION DIRECTIVE (2026-08-20), section 13:
-- "A cash payment was accepted while no cash shift was open. This is
-- NOT allowed." Root cause found: record_payment()'s shift gate (added
-- Phase D) is correctly written, but it only fires `if v_has_custody`
-- -- and has_cash_custody defaults to false with NO existing membership
-- ever set to true (confirmed live: 0 of N active memberships have
-- custody, and 72/72 historical cash payments are unlinked to any
-- shift). The gate was real but universally inert because nothing ever
-- turned it on and there was no reason for staff to know the toggle
-- existed.
--
-- Fix: the exact role set that can actually call record_payment() at
-- all is `payment.create` holders -- confirmed via role_permissions to
-- be exactly {accountant, club_owner, receptionist}. Every other role
-- (coach, scanner, academy_manager, branch_manager, club_manager,
-- platform_owner) cannot record a payment regardless of custody, so
-- leaving them at the false default is correct and not a gap.
--
-- This is a safe, reversible operational default -- custody remains a
-- real per-person toggle (StaffPage already has the control from Phase
-- D) an owner can turn off for a specific person; this migration only
-- fixes the fact that it was silently off for everyone with the power
-- to collect cash in the first place.
update public.club_memberships cm
set has_cash_custody = true, updated_at = now()
where cm.status = 'active'
  and cm.has_cash_custody = false
  and exists (
    select 1
    from public.role_permissions rp
    join public.permissions p on p.id = rp.permission_id
    where rp.role_id = cm.role_id and p.key = 'payment.create'
  );

-- Going forward: new memberships assigned a payment-capable role should
-- also default to custody on, via the same invite/role-assignment path
-- that already grants the role -- handled in invite_staff_member()
-- below rather than a blunt column-level DEFAULT (a column default
-- can't be conditional on role, and most roles genuinely should stay
-- false).

create or replace function public.invite_staff_member(
  p_club_id uuid,
  p_email text,
  p_role_key text,
  p_branch_ids uuid[] default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target_user_id uuid;
  v_role_id uuid;
  v_membership_id uuid;
  v_branch_id uuid;
  -- Directive fix: any role granted payment.create can actually collect
  -- cash, so it should start with custody on rather than silently
  -- bypassing the shift gate until someone happens to notice the
  -- StaffPage toggle exists. An owner can still turn it back off per
  -- person; this only fixes the default.
  v_default_custody boolean;
begin
  if not public.has_permission('staff.create', p_club_id) then
    raise exception 'not authorized';
  end if;

  select id into v_target_user_id
  from auth.users
  where lower(email) = lower(p_email)
  limit 1;

  if v_target_user_id is null then
    raise exception 'no account found for that email -- the person must sign up first';
  end if;

  select id into v_role_id from public.roles where key = p_role_key;
  if v_role_id is null then
    raise exception 'unknown role';
  end if;

  if p_role_key = 'platform_owner' then
    raise exception 'not authorized';
  end if;

  select exists (
    select 1 from public.role_permissions rp
    join public.permissions p on p.id = rp.permission_id
    where rp.role_id = v_role_id and p.key = 'payment.create'
  ) into v_default_custody;

  insert into public.club_memberships (user_id, club_id, role_id, status, has_cash_custody)
  values (v_target_user_id, p_club_id, v_role_id, 'active', v_default_custody)
  on conflict (user_id, club_id, role_id)
    do update set status = 'active', updated_at = now()
    -- Re-invite of an already-existing membership: leave has_cash_custody
    -- exactly as the owner last set it. Only the first-time insert path
    -- applies the default -- never silently re-enable something a club
    -- owner may have deliberately turned off.
  returning id into v_membership_id;

  delete from public.membership_branches where membership_id = v_membership_id;

  if p_branch_ids is not null then
    foreach v_branch_id in array p_branch_ids loop
      insert into public.membership_branches (membership_id, branch_id)
      values (v_membership_id, v_branch_id)
      on conflict do nothing;
    end loop;
  end if;

  return v_membership_id;
end;
$$;

revoke execute on function public.invite_staff_member(uuid, text, text, uuid[]) from public;
revoke execute on function public.invite_staff_member(uuid, text, text, uuid[]) from anon;
grant execute on function public.invite_staff_member(uuid, text, text, uuid[]) to authenticated;

-- The other real insert path: complete_new_club_onboarding() creates the
-- founding club_owner membership directly (not via invite_staff_member),
-- and club_owner always holds payment.create -- so it should start with
-- custody on too, for the same reason as above.
create or replace function public.complete_new_club_onboarding(
  p_business_type text,
  p_club_name text,
  p_club_name_ar text,
  p_branch_name text,
  p_city text,
  p_phone text,
  p_owner_email text,
  p_owner_mobile text,
  p_government_affiliated boolean default false,
  p_country text default null,
  p_phone_e164 text default null
)
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

  return query select v_club_id, v_trial_granted;
end;
$function$;

revoke all on function public.complete_new_club_onboarding(text, text, text, text, text, text, text, text, boolean, text, text) from public;
revoke all on function public.complete_new_club_onboarding(text, text, text, text, text, text, text, text, boolean, text, text) from anon;
grant execute on function public.complete_new_club_onboarding(text, text, text, text, text, text, text, text, boolean, text, text) to authenticated;

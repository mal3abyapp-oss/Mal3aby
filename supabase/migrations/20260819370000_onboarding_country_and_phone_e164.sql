-- P0 Phone Identity directive: onboarding now asks for the club's
-- default country (directive section 4/47) and stores the branch's
-- own phone as canonical E.164 alongside the existing display column.
-- p_owner_mobile continues to feed the existing trial-abuse dedup
-- snapshot unchanged (out of scope for this migration -- normalize_mobile()
-- stays as-is for that narrow purpose per ADR-012's own reasoning).
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

  insert into public.club_memberships (user_id, club_id, role_id, status)
  values (auth.uid(), v_club_id, (select id from public.roles where key = 'club_owner'), 'active');

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

drop function if exists public.complete_new_club_onboarding(text, text, text, text, text, text, text, text, boolean);

revoke all on function public.complete_new_club_onboarding(text, text, text, text, text, text, text, text, boolean, text, text) from public;
revoke all on function public.complete_new_club_onboarding(text, text, text, text, text, text, text, text, boolean, text, text) from anon;
grant execute on function public.complete_new_club_onboarding(text, text, text, text, text, text, text, text, boolean, text, text) to authenticated;

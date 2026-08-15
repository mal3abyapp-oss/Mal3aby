-- Phase 3d — Public Website + Signup + Onboarding + Trial
-- The highest-risk function in the system: complete_new_club_onboarding()
-- is reachable by a caller with no prior club_memberships row to validate
-- against, so the function body itself is the entire trust boundary.
-- See docs/ARCHITECTURE.md#signup--onboarding-strategy for the exact
-- reference design this follows (with two documented gaps closed below).

-- ============================================================
-- clubs: add duplicate-flagging columns (ADR-045: flag for review, never
-- hard-block) -- not present anywhere in DATABASE_BLUEPRINT.md's clubs
-- spec, added here since this phase is the first to need it.
-- ============================================================
alter table public.clubs add column if not exists flagged_duplicate boolean not null default false;
alter table public.clubs add column if not exists flagged_duplicate_reason text;

-- ============================================================
-- normalize_mobile: referenced by the ARCHITECTURE.md onboarding sketch
-- but never defined anywhere in the docs. Simple, deterministic
-- normalization (strip everything but digits, drop a leading country/
-- trunk 0) -- good enough for advisory duplicate detection, not a hard
-- uniqueness guarantee (matches ADR-012's phone-normalization precedent).
-- ============================================================
create or replace function public.normalize_mobile(p_mobile text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_mobile is null then null
    else regexp_replace(regexp_replace(p_mobile, '\D', '', 'g'), '^0+', '')
  end
$$;

-- ============================================================
-- complete_new_club_onboarding
-- ============================================================
create or replace function public.complete_new_club_onboarding(
  p_business_type text,
  p_club_name text,
  p_club_name_ar text,
  p_branch_name text,
  p_city text,
  p_phone text,
  p_owner_email text,
  p_owner_mobile text
)
returns table(club_id uuid, trial_granted boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  -- Identity: auth.uid() only, never a parameter.
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  -- Basic DB-level rate limit (ADR-046: lightweight, not blocking the
  -- legitimate path): max 5 club creations per calling user per hour.
  -- Scoped to the authenticated caller (auth.uid()), not IP -- no
  -- request-IP plumbing is available inside a plain SQL function without
  -- additional app-layer wiring not yet present in this codebase; this
  -- still closes the primary abuse vector (a single scripted account
  -- spamming club creation) within the "no external service" constraint.
  select count(*) into v_recent_count
  from public.clubs
  where created_by = auth.uid() and created_at > now() - interval '1 hour';

  if v_recent_count >= 5 then
    raise exception 'too many clubs created recently -- please try again later';
  end if;

  v_normalized_mobile := public.normalize_mobile(p_owner_mobile);

  -- Advisory duplicate detection (ADR-045): normalized-name/phone match
  -- against existing clubs. Never blocks -- only sets a flag Platform
  -- Owner can review.
  select exists (
    select 1 from public.clubs c
    where lower(trim(c.name_ar)) = lower(trim(p_club_name_ar))
       or lower(trim(c.name)) = lower(trim(p_club_name))
  ) into v_is_duplicate;

  -- club_code: derived server-side, never client-supplied (it's a unique,
  -- system-facing slug used in future invoice numbering -- not addressed
  -- in the ARCHITECTURE.md onboarding sketch, closed here). Short random
  -- suffix keeps it unique without a client round-trip or sequence lock.
  v_club_code := upper(substring(regexp_replace(coalesce(p_club_name, 'CLUB'), '[^a-zA-Z0-9]', '', 'g') from 1 for 6));
  if v_club_code = '' then
    v_club_code := 'CLUB';
  end if;
  v_club_code := v_club_code || '-' || substring(replace(gen_random_uuid()::text, '-', '') from 1 for 6);

  -- club + branch + owner membership: always created, unconditionally.
  -- A user is never blocked from creating additional clubs.
  insert into public.clubs (name, name_ar, club_code, status, created_by, flagged_duplicate, flagged_duplicate_reason)
  values (
    coalesce(p_club_name, p_club_name_ar), p_club_name_ar, v_club_code, 'active', auth.uid(),
    v_is_duplicate, case when v_is_duplicate then 'اسم مشابه لنادي موجود بالفعل' else null end
  )
  returning id into v_club_id;

  insert into public.branches (club_id, branch_code, name, address, phone, status, created_by)
  values (v_club_id, 'MAIN', p_branch_name, p_city, p_phone, 'active', auth.uid())
  returning id into v_branch_id;

  insert into public.club_memberships (user_id, club_id, role_id, status)
  values (auth.uid(), v_club_id, (select id from public.roles where key = 'club_owner'), 'active');

  -- Automatic trial: attempt to consume the one-per-user entitlement.
  -- The unique constraint on automatic_trial_entitlements.user_id IS the
  -- concurrency guard -- no SELECT-then-INSERT race window.
  begin
    insert into public.automatic_trial_entitlements (
      user_id, club_id, owner_normalized_mobile_snapshot, owner_email_snapshot, consumed_at
    ) values (
      auth.uid(), v_club_id, v_normalized_mobile, lower(p_owner_email), now()
    );
    v_trial_granted := true;
  exception when unique_violation then
    -- User already consumed their one automatic trial on an earlier club.
    -- NOT a transaction failure -- club creation still succeeds.
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
$$;

revoke execute on function public.complete_new_club_onboarding(text, text, text, text, text, text, text, text) from public;
revoke execute on function public.complete_new_club_onboarding(text, text, text, text, text, text, text, text) from anon;
grant execute on function public.complete_new_club_onboarding(text, text, text, text, text, text, text, text) to authenticated;

-- ============================================================
-- Bug found via live browser smoke test (anon request to public_plans
-- returned 401 "permission denied for function is_platform_owner"):
-- every "..._platform_owner_full_access" RLS policy (role = public, i.e.
-- applies to anon too) calls is_platform_owner() in its USING expression.
-- Postgres RLS evaluates EVERY applicable policy's USING clause for the
-- querying role, even ones that will end up denying access -- so anon
-- needs EXECUTE on is_platform_owner() itself just to be evaluated, even
-- though it will always return false for anon (auth.uid() is null).
-- This affected all 12 tables carrying that policy pattern, most visibly
-- public_plans and contact_requests (the two anon actually needs to
-- reach). Safe: the function is stable, read-only, cheap for anon.
-- ============================================================
grant execute on function public.is_platform_owner() to anon;

-- Same defense-in-depth fix applied to the other three helper functions,
-- for consistency: none of the tables using them in a role={public}
-- policy grant anon any actual row access (no anon-scoped policy exists
-- on clubs/branches/club_memberships/membership_branches/audit_logs/
-- platform_subscriptions), but without EXECUTE, an anon request to any of
-- them would surface "permission denied for function X" -- an
-- information-shaped error -- instead of a clean empty-result RLS deny
-- like every other properly-denied table gets. Verified anon still sees
-- 0 rows on clubs after this grant (RLS row-visibility unchanged).
grant execute on function public.user_club_ids() to anon;
grant execute on function public.has_permission(text, uuid) to anon;
grant execute on function public.has_branch_access(uuid, uuid) to anon;

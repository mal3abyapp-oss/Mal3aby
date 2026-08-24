-- Fixes a confirmed remaining gap in get_customer_duplicate_groups's
-- email-based duplicate report (added in 20260824070000_email_duplicate_
-- groups_for_phoneless_customers.sql): that migration's `dup_emails` /
-- `email_members` CTEs were scoped to `c.phone_e164 is null` on BOTH
-- sides of the match, so a same-email pair where either customer *has*
-- a phone number on file is still invisible to the report -- exactly
-- the scenario in this finding: Customer X is created via the public
-- booking link with phone A (create_public_booking never even collects
-- an email, per 20260824040000) and later a staff member creates
-- Customer Y with a different phone B but the same real email address
-- (e.g. a phone typo, or the customer switched SIM and used their
-- known email at the front desk). Neither X nor Y has phone_e164 null,
-- so the existing email grouping's `where c.phone_e164 is null` filter
-- excludes both rows and the match is never surfaced, even though
-- upsert_customer's phone-only lookup (all three sites: update-path
-- collision check, create-path existing-customer check, and the
-- unique_violation fallback) never compares email at all and so never
-- catches it either.
--
-- Fix: drop the `phone_e164 is null` restriction from the email
-- grouping entirely. Group by (club_id, lower(trim(email))) across ALL
-- customers with a non-blank email, independent of whether they also
-- have a phone on file. A customer that appears in both the phone
-- group and the email group is not a bug -- it just means two
-- independent signals both flagged it, which is exactly the point of a
-- review report; each row keeps its own duplicate_review_status so
-- staff still see a consistent picture in whichever group they look
-- at.
--
-- Deliberately still not a hard block or auto-merge at write time, and
-- upsert_customer's create-vs-block decision is left completely
-- unchanged: per the Customer 360 directive that has been followed
-- consistently across the phone-dedup history (20260820250000,
-- 20260820310000, 20260820320000) and reaffirmed in 20260824070000's
-- own comment, two genuinely different people (e.g. family members
-- sharing a household email) can legitimately share an email, so this
-- stays a soft/review-only signal surfaced through the existing,
-- already-audited quarantine workflow -- never a silent auto-collapse
-- of customer identity.
--
-- Safe because: read-only (stable, security definer, same
-- customer.view-gated authorization as before, matching function
-- signature exactly via create or replace); does not touch
-- upsert_customer, create_public_booking, bookings, invoices,
-- payments, or consent; the 'groups' (phone) key/shape is completely
-- untouched; only the pre-existing 'email_groups' key's row set grows
-- to include phoned customers -- the frontend (CustomerDuplicatesPage.
-- tsx) already renders 'email_groups' generically via the same
-- DuplicateMemberList component used for phone groups, so no frontend
-- change is required for the additional rows to display correctly.
create or replace function public.get_customer_duplicate_groups(
  p_club_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_groups jsonb;
  v_email_groups jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  with dup_phones as (
    select phone_e164
    from public.customers
    where club_id = p_club_id and phone_e164 is not null
    group by phone_e164
    having count(*) > 1
  ),
  members as (
    select
      c.phone_e164,
      c.id,
      c.full_name,
      c.mobile_display,
      c.duplicate_review_status,
      c.created_at,
      (select count(*) from public.bookings b where b.customer_id = c.id) as bookings_count,
      (select count(*) from public.guardian_links gl where gl.customer_id = c.id) as players_count,
      exists(select 1 from public.invoices i where i.customer_id = c.id) as has_invoices
    from public.customers c
    join dup_phones dp on dp.phone_e164 = c.phone_e164
    where c.club_id = p_club_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'phone_e164', g.phone_e164,
    'customers', g.customers
  ) order by g.phone_e164), '[]'::jsonb) into v_groups
  from (
    select
      m.phone_e164,
      jsonb_agg(jsonb_build_object(
        'id', m.id,
        'full_name', m.full_name,
        'mobile_display', m.mobile_display,
        'duplicate_review_status', m.duplicate_review_status,
        'created_at', m.created_at,
        'bookings_count', m.bookings_count,
        'players_count', m.players_count,
        'has_invoices', m.has_invoices
      ) order by m.created_at asc) as customers
    from members m
    group by m.phone_e164
  ) g;

  -- Email-based duplicate signal: group ALL customers in the club by
  -- normalized email (case/whitespace-insensitive), regardless of
  -- whether phone_e164 is present. This intentionally overlaps with
  -- the phone grouping above for a customer that matches on both
  -- signals -- that customer will legitimately appear in both
  -- 'groups' and 'email_groups', which is correct: they are two
  -- independent duplicate signals, not mutually exclusive categories.
  with dup_emails as (
    select lower(trim(c.email)) as email_key
    from public.customers c
    where c.club_id = p_club_id and c.email is not null and length(trim(c.email)) > 0
    group by lower(trim(c.email))
    having count(*) > 1
  ),
  email_members as (
    select
      lower(trim(c.email)) as email_key,
      c.email,
      c.id,
      c.full_name,
      c.mobile_display,
      c.duplicate_review_status,
      c.created_at,
      (select count(*) from public.bookings b where b.customer_id = c.id) as bookings_count,
      (select count(*) from public.guardian_links gl where gl.customer_id = c.id) as players_count,
      exists(select 1 from public.invoices i where i.customer_id = c.id) as has_invoices
    from public.customers c
    join dup_emails de on de.email_key = lower(trim(c.email))
    where c.club_id = p_club_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'email', g.email,
    'customers', g.customers
  ) order by g.email), '[]'::jsonb) into v_email_groups
  from (
    select
      min(m.email) as email,
      jsonb_agg(jsonb_build_object(
        'id', m.id,
        'full_name', m.full_name,
        'mobile_display', m.mobile_display,
        'duplicate_review_status', m.duplicate_review_status,
        'created_at', m.created_at,
        'bookings_count', m.bookings_count,
        'players_count', m.players_count,
        'has_invoices', m.has_invoices
      ) order by m.created_at asc) as customers
    from email_members m
    group by m.email_key
  ) g;

  return jsonb_build_object('groups', v_groups, 'email_groups', v_email_groups);
end;
$function$;

-- Grants unchanged from the prior migration; re-stated for clarity
-- since create or replace does not alter existing grants.
revoke all on function public.get_customer_duplicate_groups(uuid) from public;
revoke all on function public.get_customer_duplicate_groups(uuid) from anon;
grant execute on function public.get_customer_duplicate_groups(uuid) to authenticated;

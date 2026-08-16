-- Gate 3 continued: find_claimable_customer() backs the self-service
-- claim flow's confirmation step (ClaimAccountPage.tsx). Deliberately
-- narrow to avoid becoming a customer-enumeration endpoint:
--   - exact normalized-mobile match only (no partial/fuzzy search)
--   - only returns customers with user_id IS NULL (already-claimed
--     records never appear here, so this can't be used to probe
--     whether a given phone number belongs to an existing linked
--     account)
--   - returns only id/full_name/mobile_display/club_id -- never email,
--     national_id, address, financial data, or any other customer PII
--   - requires an authenticated caller (auth.uid() is not null) --
--     never callable by anon, so a bare unauthenticated scraper can't
--     enumerate this at all
--   - the one real residual risk (an authenticated attacker brute-
--     forcing phone numbers to discover which numbers belong to real
--     customers of a club) is not eliminated by this function alone;
--     it should be paired with rate limiting at the platform/edge
--     level in a later hardening pass (tracked, not silently ignored --
--     see Gate 3 follow-up items).
create or replace function public.find_claimable_customer(
  p_club_id uuid,
  p_normalized_mobile text
)
returns table(id uuid, full_name text, mobile_display text, club_id uuid)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_normalized_mobile is null or length(p_normalized_mobile) < 6 then
    raise exception 'invalid mobile number';
  end if;

  return query
    select c.id, c.full_name, c.mobile_display, c.club_id
    from public.customers c
    where c.club_id = p_club_id
      and c.user_id is null
      and c.normalized_mobile = p_normalized_mobile
    limit 5;
end;
$$;

revoke execute on function public.find_claimable_customer(uuid, text) from public, anon;
grant execute on function public.find_claimable_customer(uuid, text) to authenticated;

comment on function public.find_claimable_customer is
  'Narrow exact-match lookup backing the self-service account-claim flow. Returns only unclaimed customer records (user_id IS NULL) matching an exact normalized mobile number within one club -- never a general search/enumeration endpoint.';

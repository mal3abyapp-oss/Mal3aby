-- FIX: request_commercial_upgrade() computed academy_limit
-- current_usage from public.groups, not public.programs.
--
-- Found during the WORKSTREAM B commercial/billing enforcement review
-- (2026-09-06): get_commercial_usage() (20260904210100_commercial_
-- packaging_usage_rpcs.sql) carries an explicit comment establishing
-- public.programs as the ONE authoritative "academy unit" count --
-- matching enforce_academy_limit()'s own INSERT-time trigger query
-- (20260816100000_commercial_entitlements.sql) exactly: "one active
-- Academy Program = one licensed academy unit... this must count
-- public.programs, not public.groups... Counting from `groups` instead
-- would show a usage number that disagrees with what the real
-- INSERT-time trigger enforces."
--
-- request_commercial_upgrade() (introduced 20260824230200, predating
-- that fix/comment) was never updated to match and still counts
-- public.groups (training groups WITHIN a program -- a materially
-- different, unrelated concept, not gated by the academy limit at
-- all). Live-confirmed on a real club: 2 active programs vs 3 active
-- groups -- an owner filing an academy-limit upgrade request today
-- would have current_usage recorded as 3, not the real/enforced 2, in
-- commercial_upgrade_requests, which is read by Platform Owner staff
-- reviewing the request (get_commercial_usage/EntitlementsCard.tsx are
-- the only correct source, but this request row carries its own,
-- disagreeing snapshot).
--
-- Not a billing/security bypass (the request is informational only --
-- no entitlement is granted by this RPC, only a review-queue row is
-- inserted; enforce_academy_limit() remains the actual, correctly-
-- sourced gate) -- P2 data-integrity/contract-drift fix, not P0.
--
-- Fix: change the academy_limit branch to count public.programs,
-- matching get_commercial_usage/enforce_academy_limit exactly. Every
-- other line (branch_limit/field_limit sources, the has_permission
-- gate from the prior fix, signature) is unchanged.
create or replace function public.request_commercial_upgrade(
  p_club_id uuid,
  p_limit_type text,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_id uuid;
  v_current_limit integer;
  v_current_usage integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids())) then
    raise exception 'not authorized';
  end if;

  if not public.has_permission('club.update', p_club_id) then
    raise exception 'not authorized';
  end if;

  if p_limit_type not in ('branch_limit', 'field_limit', 'academy_limit') then
    raise exception 'unknown limit type';
  end if;

  select
    case p_limit_type
      when 'branch_limit' then branch_limit
      when 'field_limit' then field_limit
      when 'academy_limit' then academy_limit
    end
  into v_current_limit
  from public.commercial_entitlements where club_id = p_club_id;

  v_current_usage := case p_limit_type
    when 'branch_limit' then (select count(*) from public.branches where club_id = p_club_id and status = 'active')
    when 'field_limit' then (select count(*) from public.fields where club_id = p_club_id and status = 'active')
    when 'academy_limit' then (select count(*) from public.programs where club_id = p_club_id and status = 'active')
  end;

  insert into public.commercial_upgrade_requests (club_id, requested_by, limit_type, current_limit, current_usage, note)
  values (p_club_id, auth.uid(), p_limit_type, v_current_limit, v_current_usage, p_note)
  returning id into v_request_id;

  return v_request_id;
end;
$$;

-- Grants unchanged from the prior migration (authenticated only, no
-- anon/public execute) -- CREATE OR REPLACE does not reset grants, but
-- restated here for clarity/auditability of this function's full
-- current state.
revoke execute on function public.request_commercial_upgrade(uuid, text, text) from public;
revoke execute on function public.request_commercial_upgrade(uuid, text, text) from anon;
grant execute on function public.request_commercial_upgrade(uuid, text, text) to authenticated;

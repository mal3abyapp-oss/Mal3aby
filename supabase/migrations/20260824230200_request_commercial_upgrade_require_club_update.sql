-- Security fix: public.request_commercial_upgrade(uuid, text, text) had no
-- role/permission check beyond tenant membership (p_club_id in
-- user_club_ids()), which returns every club a user has ANY active
-- membership in regardless of role. This let a low-privilege member
-- (e.g. a Coach with no club.update permission) file commercial upgrade
-- requests -- a capability the frontend's isOwnerOrManager gate
-- (src/features/clubs/EntitlementsCard.tsx) intends to restrict to
-- Owner/Manager. There is no other server-side enforcement point: the
-- underlying commercial_upgrade_requests_insert_own_club RLS policy
-- (20260816320000_gate12_rls_auth_uid_initplan_fix.sql) also checks only
-- club membership + requested_by = auth.uid(), no role gate.
--
-- Fix: require has_permission('club.update', p_club_id) inside the RPC,
-- matching the exact permission key already used for this same
-- Owner/Manager-level boundary elsewhere (e.g. clubs UPDATE RLS policy in
-- 20260815120000_phase2_identity_multitenant_rls.sql:229, and the platform
-- billing view grant in 20260815140000_phase3b_platform_billing.sql:329).
-- Signature is preserved exactly (uuid, text, text) to avoid creating an
-- orphaned overload.

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
    when 'academy_limit' then (select count(*) from public.groups where club_id = p_club_id and status = 'active')
  end;

  insert into public.commercial_upgrade_requests (club_id, requested_by, limit_type, current_limit, current_usage, note)
  values (p_club_id, auth.uid(), p_limit_type, v_current_limit, v_current_usage, p_note)
  returning id into v_request_id;

  return v_request_id;
end;
$$;

revoke execute on function public.request_commercial_upgrade(uuid, text, text) from public;
revoke execute on function public.request_commercial_upgrade(uuid, text, text) from anon;
grant execute on function public.request_commercial_upgrade(uuid, text, text) to authenticated;

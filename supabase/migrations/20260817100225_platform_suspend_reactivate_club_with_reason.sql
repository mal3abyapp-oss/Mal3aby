-- Owner-level review finding (P0/P1, real live bug caught before it
-- could fire): "إيقاف النادي" (Suspend Club) -- the single most
-- destructive Platform Owner action in the system, capable of shutting
-- down a real paying customer's entire business operation -- fired a
-- raw `clubs.update({status:'suspended'})` directly on click with ZERO
-- confirmation and NO audit trail, while the adjacent (less severe)
-- "إلغاء الاشتراك" action in the exact same file correctly requires a
-- typed reason via cancel_platform_subscription() + write_audit_log().
-- write_audit_log() is correctly locked to service_role/postgres only
-- (confirmed via pg_proc.proacl) -- the client literally cannot call
-- it directly, so a client-side confirm dialog alone would still leave
-- this specific action unaudited. Fixed with a proper RPC mirroring
-- cancel_platform_subscription()'s exact shape: platform-owner-gated,
-- reason required, audit-logged with real before/after state.
create or replace function public.platform_suspend_club(p_club_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before record;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a suspension reason is required';
  end if;

  select * into v_before from public.clubs where id = p_club_id;
  if v_before is null then
    raise exception 'club not found';
  end if;
  if v_before.status = 'suspended' then
    raise exception 'club is already suspended';
  end if;

  update public.clubs set status = 'suspended' where id = p_club_id;

  perform public.write_audit_log(
    p_club_id, 'platform_suspend_club', 'clubs', p_club_id,
    to_jsonb(v_before), jsonb_build_object('status', 'suspended'), p_reason
  );
end;
$$;

revoke execute on function public.platform_suspend_club(uuid, text) from public, anon;
grant execute on function public.platform_suspend_club(uuid, text) to authenticated;

comment on function public.platform_suspend_club(uuid, text) is
  'Owner-level review fix: platform_owner-only, requires a non-empty reason, audit-logged. Replaces a raw client-side clubs.update() that had no confirmation, no reason, and no audit trail for the most destructive Platform Owner action in the system.';

-- Symmetric fix for reactivate, matching the same pattern (no reason
-- required to re-open a club -- lower risk, but still gets a real
-- audit trail instead of an untracked raw table write).
create or replace function public.platform_reactivate_club(p_club_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before record;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  select * into v_before from public.clubs where id = p_club_id;
  if v_before is null then
    raise exception 'club not found';
  end if;
  if v_before.status = 'active' then
    raise exception 'club is already active';
  end if;

  update public.clubs set status = 'active' where id = p_club_id;

  perform public.write_audit_log(
    p_club_id, 'platform_reactivate_club', 'clubs', p_club_id,
    to_jsonb(v_before), jsonb_build_object('status', 'active'), null
  );
end;
$$;

revoke execute on function public.platform_reactivate_club(uuid) from public, anon;
grant execute on function public.platform_reactivate_club(uuid) to authenticated;

comment on function public.platform_reactivate_club(uuid) is
  'Owner-level review fix: platform_owner-only, audit-logged. Replaces a raw client-side clubs.update() with no audit trail.';

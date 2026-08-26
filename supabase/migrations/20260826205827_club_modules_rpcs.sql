-- COMMERCIAL MODULE ARCHITECTURE, continued -- RPCs for reading and
-- mutating club_modules. Two distinct write paths matching the
-- two-level state (Section 3 of COMMERCIAL_DOMAIN_ARCHITECTURE.md):
-- platform controls `entitled`, club owner controls `active` (only
-- while entitled).

create or replace function public.get_club_modules(p_club_id uuid)
returns table(module_key text, entitled boolean, active boolean, updated_at timestamptz)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (
    p_club_id in (select public.user_club_ids())
    or public.is_platform_owner()
    or public.has_platform_permission('platform.club.view')
    or public.has_platform_support_access(p_club_id, false)
  ) then
    raise exception 'not authorized';
  end if;

  return query
  select cm.module_key, cm.entitled, cm.active, cm.updated_at
  from public.club_modules cm
  where cm.club_id = p_club_id
  order by cm.module_key;
end;
$$;

revoke all on function public.get_club_modules(uuid) from public;
revoke all on function public.get_club_modules(uuid) from anon;
grant execute on function public.get_club_modules(uuid) to authenticated;

-- set_club_module_entitlement(): PLATFORM-ONLY. Turning entitlement
-- off also forces active=false in the same statement (the CHECK
-- constraint would reject leaving active=true with entitled=false
-- anyway, but doing it explicitly here means the caller never sees a
-- constraint-violation error for the ordinary "turn off Shop" case).
create or replace function public.set_club_module_entitlement(p_club_id uuid, p_module_key text, p_entitled boolean)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before public.club_modules;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.club.manage')) then
    raise exception 'not authorized';
  end if;
  if p_module_key not in ('fields', 'academy', 'shop') then
    raise exception 'unknown module';
  end if;

  select * into v_before from public.club_modules where club_id = p_club_id and module_key = p_module_key;
  if v_before.id is null then
    raise exception 'module row not found for this club';
  end if;

  update public.club_modules
  set entitled = p_entitled,
      active = case when not p_entitled then false else active end,
      updated_at = now(),
      updated_by = auth.uid()
  where club_id = p_club_id and module_key = p_module_key;

  perform public.write_audit_log(
    p_club_id,
    case when p_entitled then 'module.entitled' else 'module.unentitled' end,
    'club_module', v_before.id,
    jsonb_build_object('entitled', v_before.entitled, 'active', v_before.active),
    jsonb_build_object('entitled', p_entitled, 'active', case when not p_entitled then false else v_before.active end),
    null
  );
end;
$$;

revoke all on function public.set_club_module_entitlement(uuid, text, boolean) from public;
revoke all on function public.set_club_module_entitlement(uuid, text, boolean) from anon;
grant execute on function public.set_club_module_entitlement(uuid, text, boolean) to authenticated;

-- set_club_module_active(): club owner (or an active MANAGE support
-- session, mirroring the Master Admin support-mode pattern already
-- established for club role CRUD) turns a module on/off day-to-day.
-- Refuses to activate a module that isn't platform-entitled.
create or replace function public.set_club_module_active(p_club_id uuid, p_module_key text, p_active boolean)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before public.club_modules;
  v_via_support boolean;
begin
  v_via_support := not public.has_permission('club.update', p_club_id) and public.has_platform_support_access(p_club_id, true);
  if not (public.has_permission('club.update', p_club_id) or v_via_support) then
    raise exception 'not authorized';
  end if;
  if p_module_key not in ('fields', 'academy', 'shop') then
    raise exception 'unknown module';
  end if;

  select * into v_before from public.club_modules where club_id = p_club_id and module_key = p_module_key;
  if v_before.id is null then
    raise exception 'module row not found for this club';
  end if;
  if p_active and not v_before.entitled then
    raise exception 'this module is not available on your current plan -- contact support to enable it';
  end if;

  update public.club_modules
  set active = p_active, updated_at = now(), updated_by = auth.uid()
  where club_id = p_club_id and module_key = p_module_key;

  perform public.write_audit_log(
    p_club_id,
    case when p_active then 'module.activated' else 'module.deactivated' end,
    'club_module', v_before.id,
    jsonb_build_object('active', v_before.active),
    jsonb_build_object('active', p_active),
    null
  );

  if v_via_support then
    perform public.write_audit_log_as_support(
      p_club_id,
      case when p_active then 'module.activated' else 'module.deactivated' end,
      'club_module', v_before.id,
      jsonb_build_object('active', v_before.active),
      jsonb_build_object('active', p_active),
      null
    );
  end if;
end;
$$;

revoke all on function public.set_club_module_active(uuid, text, boolean) from public;
revoke all on function public.set_club_module_active(uuid, text, boolean) from anon;
grant execute on function public.set_club_module_active(uuid, text, boolean) to authenticated;

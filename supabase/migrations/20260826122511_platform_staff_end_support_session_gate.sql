-- PLATFORM STAFF EXTENSION -- same fix as start_platform_support_session:
-- end_platform_support_session() must let a platform_staff_memberships-
-- tracked employee end THEIR OWN session too, not just a real
-- is_platform_owner(). Directive Section 15 ("support mode must end when
-- the admin explicitly exits") applies equally to platform staff, not
-- just the Platform Owner. Widened using the same
-- has_platform_permission('platform.support.start_view' OR
-- '...start_manage') condition -- if they were authorized to START a
-- session, they are authorized to END it.
create or replace function public.end_platform_support_session()
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_session record;
begin
  if not (
    public.is_platform_owner()
    or public.has_platform_permission('platform.support.start_view')
    or public.has_platform_permission('platform.support.start_manage')
  ) then
    raise exception 'not authorized';
  end if;

  select id, club_id into v_session
  from public.platform_support_sessions
  where platform_owner_id = auth.uid() and ended_at is null
  limit 1;

  if v_session.id is null then
    return;
  end if;

  update public.platform_support_sessions set ended_at = now() where id = v_session.id;

  perform public.write_audit_log(
    v_session.club_id, 'platform_support.session_ended', 'platform_support_session', v_session.id,
    null, jsonb_build_object('auto_ended_by', 'explicit_exit'), null
  );
end;
$$;

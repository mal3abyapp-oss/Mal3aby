-- PLATFORM STAFF EXTENSION (2026-08-26) -- directive Section 8's explicit
-- requirement: "Master Admin support access must depend on PLATFORM
-- permissions... Platform Support role: start_view=ALLOW, start_manage=
-- DENY." Until now, start_platform_support_session()/its RLS policy only
-- ever checked is_platform_owner() -- correct for the Platform Owner
-- (unaffected, still works exactly as before), but wrong for the whole
-- point of platform_staff_memberships: a Platform Support employee with
-- platform.support.start_view could not start even a VIEW-mode session,
-- confirmed live before this fix (a real P0001 'not authorized').
--
-- Widened consistently at BOTH layers that gate this insert (the RPC's
-- own check AND the table's RLS policy -- an RPC-only widening would
-- still be blocked by RLS on the actual INSERT, since SECURITY DEFINER
-- does not bypass RLS by itself in this project's established pattern).
create or replace function public.start_platform_support_session(p_club_id uuid, p_mode text, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_prior_session record;
  v_session_id uuid;
begin
  if p_mode not in ('view', 'manage') then
    raise exception 'invalid mode';
  end if;

  if not (
    public.is_platform_owner()
    or public.has_platform_permission(case when p_mode = 'manage' then 'platform.support.start_manage' else 'platform.support.start_view' end)
  ) then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.clubs where id = p_club_id) then
    raise exception 'club not found';
  end if;

  -- End any other active session for this platform owner first.
  for v_prior_session in
    select id, club_id from public.platform_support_sessions
    where platform_owner_id = auth.uid() and ended_at is null
  loop
    update public.platform_support_sessions set ended_at = now() where id = v_prior_session.id;
    perform public.write_audit_log(
      v_prior_session.club_id, 'platform_support.session_ended', 'platform_support_session', v_prior_session.id,
      null, jsonb_build_object('auto_ended_by', 'new_session_started'), null
    );
  end loop;

  insert into public.platform_support_sessions (platform_owner_id, club_id, mode, reason)
  values (auth.uid(), p_club_id, p_mode, p_reason)
  returning id into v_session_id;

  perform public.write_audit_log(
    p_club_id, 'platform_support.session_started', 'platform_support_session', v_session_id,
    null, jsonb_build_object('mode', p_mode, 'reason', p_reason), p_reason
  );

  return v_session_id;
end;
$$;

-- RLS policy widened to match: a platform_staff_memberships-tracked
-- employee holding platform.support.start_view/start_manage may now
-- create/read/end THEIR OWN session rows too (platform_owner_id =
-- auth.uid() still strictly enforced -- never anyone else's, exactly the
-- same invariant as before). No circular-dependency risk: this policy's
-- own USING/WITH CHECK clause calls has_platform_permission(), which
-- reads platform_staff_memberships/platform_role_permissions/
-- platform_custom_role_permissions -- NONE of which read
-- platform_support_sessions itself, so there is no cycle.
drop policy platform_support_sessions_owner_all on public.platform_support_sessions;
create policy platform_support_sessions_owner_all
  on public.platform_support_sessions
  for all
  using (
    platform_owner_id = auth.uid()
    and (public.is_platform_owner() or public.has_platform_permission('platform.support.start_view') or public.has_platform_permission('platform.support.start_manage'))
  )
  with check (
    platform_owner_id = auth.uid()
    and (public.is_platform_owner() or public.has_platform_permission('platform.support.start_view') or public.has_platform_permission('platform.support.start_manage'))
  );

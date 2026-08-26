-- Central authorization helper -- the ONE place "is this caller a
-- platform owner with an active MANAGE/VIEW session for exactly this
-- club" is decided. Every downstream RLS policy/RPC widening added for
-- this feature must call this function rather than re-deriving the
-- session-lookup logic inline (directive Section 6: "centralize
-- platform-owner bypass safely... avoid scattering OR is_platform_owner()
-- through hundreds of policies without architecture").
create or replace function public.has_platform_support_access(p_club_id uuid, p_require_manage boolean default false)
returns boolean
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select public.is_platform_owner()
    and exists (
      select 1 from public.platform_support_sessions s
      where s.platform_owner_id = auth.uid()
        and s.club_id = p_club_id
        and s.ended_at is null
        and s.expires_at > now()
        and (not p_require_manage or s.mode = 'manage')
    )
$$;

revoke all on function public.has_platform_support_access(uuid, boolean) from public;
revoke all on function public.has_platform_support_access(uuid, boolean) from anon;
grant execute on function public.has_platform_support_access(uuid, boolean) to authenticated;

-- start_platform_support_session: only a real platform_owner may call
-- this. Ends any of the caller's OTHER active sessions first (one active
-- session per platform_owner at a time -- prevents stale/forgotten
-- contexts accumulating, directive Section 15). Writes a real audit_logs
-- row via the EXISTING write_audit_log (actor_id = auth.uid() = the real
-- platform owner, never spoofed -- this function takes no actor
-- parameter at all).
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
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if p_mode not in ('view', 'manage') then
    raise exception 'invalid mode';
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

revoke all on function public.start_platform_support_session(uuid, text, text) from public;
revoke all on function public.start_platform_support_session(uuid, text, text) from anon;
grant execute on function public.start_platform_support_session(uuid, text, text) to authenticated;

create or replace function public.end_platform_support_session()
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_session record;
begin
  if not public.is_platform_owner() then
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

revoke all on function public.end_platform_support_session() from public;
revoke all on function public.end_platform_support_session() from anon;
grant execute on function public.end_platform_support_session() to authenticated;

-- get_my_active_support_session: the SERVER-VERIFIED source of truth the
-- frontend polls -- never trust localStorage alone (directive Section 15).
create or replace function public.get_my_active_support_session()
returns table(id uuid, club_id uuid, club_name_ar text, mode text, reason text, started_at timestamptz, expires_at timestamptz)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select s.id, s.club_id, c.name_ar, s.mode, s.reason, s.started_at, s.expires_at
  from public.platform_support_sessions s
  join public.clubs c on c.id = s.club_id
  where s.platform_owner_id = auth.uid()
    and public.is_platform_owner()
    and s.ended_at is null
    and s.expires_at > now()
  limit 1
$$;

revoke all on function public.get_my_active_support_session() from public;
revoke all on function public.get_my_active_support_session() from anon;
grant execute on function public.get_my_active_support_session() to authenticated;

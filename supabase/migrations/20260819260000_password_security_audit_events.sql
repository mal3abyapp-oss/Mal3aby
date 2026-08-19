-- Platform Owner & Password Security directive: audit logging for
-- password events. write_audit_log() itself is intentionally NOT
-- exposed to authenticated (postgres/service_role only -- it's the
-- internal helper other RPCs call after their own authorization
-- checks). Password events are account-level, not club-scoped -- the
-- existing audit_logs.club_id is nullable specifically for this kind
-- of entry, and audit_logs_platform_owner_select already grants the
-- platform owner visibility into every row regardless of club_id, so
-- a NULL-club_id password event is correctly visible to the one role
-- that should see it, with no new RLS policy needed.
--
-- Two thin, narrowly-scoped entry points (REUSE BEFORE CREATE --
-- both just call the same underlying insert pattern write_audit_log()
-- already uses, not a second audit mechanism):
--
-- log_own_password_changed() -- any authenticated user may log their
-- OWN password change. No privilege check beyond "has a session" is
-- needed: the row is scoped to auth.uid() as both actor and (implicit)
-- subject, and it carries no sensitive payload.
--
-- log_password_reset_event() -- distinguishes a self-service forgot-
-- password request (actor = the requesting user, action
-- PASSWORD_RESET_REQUESTED) from a platform-owner-initiated reset
-- (checked server-side via is_platform_owner() -- action
-- PASSWORD_RESET_BY_PLATFORM_OWNER, target_user_id recorded). Neither
-- path ever receives or stores a password, hash, or token -- only the
-- event metadata.

create or replace function public.log_own_password_changed()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  insert into public.audit_logs (club_id, actor_id, action, entity_type, entity_id, before, after, reason)
  values (null, auth.uid(), 'PASSWORD_CHANGED_SELF', 'auth_user', auth.uid(), null, null, null);
end;
$$;

-- "revoke ... from public" alone does not strip anon's own separate
-- default-privilege grant on this database (confirmed via
-- pg_proc.proacl -- anon gets its own explicit "anon=X" ACL entry, not
-- just inherited PUBLIC membership) -- revoke from anon explicitly too.
revoke execute on function public.log_own_password_changed() from public;
revoke execute on function public.log_own_password_changed() from anon;
grant execute on function public.log_own_password_changed() to authenticated;

create or replace function public.log_password_reset_event(p_kind text, p_target_user_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_kind = 'self_requested' then
    if auth.uid() is null then
      raise exception 'authentication required';
    end if;
    insert into public.audit_logs (club_id, actor_id, action, entity_type, entity_id, before, after, reason)
    values (null, auth.uid(), 'PASSWORD_RESET_REQUESTED', 'auth_user', auth.uid(), null, null, null);
  elsif p_kind = 'platform_owner_initiated' then
    if not public.is_platform_owner() then
      raise exception 'not authorized';
    end if;
    if p_target_user_id is null then
      raise exception 'target user is required';
    end if;
    insert into public.audit_logs (club_id, actor_id, action, entity_type, entity_id, before, after, reason)
    values (null, auth.uid(), 'PASSWORD_RESET_BY_PLATFORM_OWNER', 'auth_user', p_target_user_id, null, null, null);
  else
    raise exception 'unknown reset event kind';
  end if;
end;
$$;

revoke execute on function public.log_password_reset_event(text, uuid) from public;
revoke execute on function public.log_password_reset_event(text, uuid) from anon;
grant execute on function public.log_password_reset_event(text, uuid) to authenticated;

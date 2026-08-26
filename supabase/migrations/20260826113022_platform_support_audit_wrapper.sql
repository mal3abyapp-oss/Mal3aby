-- Additive, backward-compatible: existing audit_logs rows and every
-- existing write_audit_log() call site are completely unaffected --
-- new nullable/defaulted columns only, and write_audit_log() itself is
-- NOT modified (confirmed: 0 lines of its body touched).
alter table public.audit_logs
  add column acting_as_platform_admin boolean not null default false,
  add column support_session_id uuid references public.platform_support_sessions(id);

-- write_audit_log_as_support: the ONLY way a mutation gets attributed as
-- "changed by Platform Admin" in the trail. Requires a genuine active
-- support session for the EXACT club being written about -- cannot be
-- called to attribute an action against club B while the session targets
-- club A. actor_id is always auth.uid() (the real platform owner) via
-- the underlying write_audit_log() call -- never spoofable, no actor
-- parameter accepted.
create or replace function public.write_audit_log_as_support(
  p_club_id uuid, p_action text, p_entity_type text, p_entity_id uuid,
  p_before jsonb, p_after jsonb, p_reason text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_session_id uuid;
begin
  select id into v_session_id
  from public.platform_support_sessions
  where platform_owner_id = auth.uid()
    and club_id = p_club_id
    and ended_at is null
    and expires_at > now()
  limit 1;

  if v_session_id is null then
    raise exception 'no active platform support session for this club';
  end if;

  insert into public.audit_logs (club_id, actor_id, action, entity_type, entity_id, before, after, reason, acting_as_platform_admin, support_session_id)
  values (p_club_id, auth.uid(), p_action, p_entity_type, p_entity_id, p_before, p_after, p_reason, true, v_session_id);
end;
$$;

revoke all on function public.write_audit_log_as_support(uuid, text, text, uuid, jsonb, jsonb, text) from public;
revoke all on function public.write_audit_log_as_support(uuid, text, text, uuid, jsonb, jsonb, text) from anon;
grant execute on function public.write_audit_log_as_support(uuid, text, text, uuid, jsonb, jsonb, text) to authenticated;

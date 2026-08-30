-- FULL SAAS ACCEPTANCE SWEEP (2026-08-30) -- Audit & Platform
-- Operations item 6, finding #1 from the 2026-08-29 platform-owner
-- acceptance pass (.claude/agent-memory-local/product-explorer/
-- project_platform_owner_acceptance_2026-08-29.md): every other
-- dangerous platform-owner RPC (suspend/cancel/reverse-payment/
-- extend-grace, and now the payment kill switch and provider-policy
-- block fixed in this same sweep) requires a non-empty reason both
-- client- and server-side. start_platform_support_session() already
-- required one for 'manage' mode but left 'view' mode fully optional --
-- confirmed live: 5 of 16 real support_sessions rows had no reason,
-- visible as "--" on PlatformSupportHistoryPage's own accountability
-- screen. 'view' mode still grants live read access into a real
-- customer's club data; it deserves the same accountability as every
-- other consequential platform action, not a lower bar. Body otherwise
-- byte-identical to the live definition.
create or replace function public.start_platform_support_session(p_club_id uuid, p_mode text, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_prior_session record;
  v_session_id uuid;
begin
  if p_mode not in ('view', 'manage') then
    raise exception 'invalid mode';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to start a support session';
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

  perform public.record_platform_club_access(p_club_id);

  return v_session_id;
end;
$function$;

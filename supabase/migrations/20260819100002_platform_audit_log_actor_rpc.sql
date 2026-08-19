-- Phase A directive A4/A5/A6: Audit Log never selected actor_id (so "who
-- did this" was unanswerable from the UI at all, despite the column
-- existing) and never selected before/after (so "what changed" was also
-- unanswerable). Both are real, confirmed gaps from the live audit.
--
-- Rather than expose actor_id (an auth.users FK) directly to the client
-- and force a second per-row lookup (N+1 again), resolve actor name/email
-- server-side in one query via a dedicated RPC, and add filter params
-- (date range, actor, action, entity_type, club_id) so the page doesn't
-- need to pull the whole table client-side to filter it.
create or replace function public.get_platform_audit_log(
  p_limit int default 200,
  p_offset int default 0,
  p_actor_id uuid default null,
  p_action text default null,
  p_entity_type text default null,
  p_club_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table(
  id uuid,
  club_id uuid,
  club_name text,
  actor_id uuid,
  actor_name text,
  actor_email text,
  action text,
  entity_type text,
  entity_id uuid,
  before jsonb,
  after jsonb,
  reason text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  return query
  select
    al.id, al.club_id, c.name_ar as club_name,
    al.actor_id,
    coalesce(p.full_name, 'SYSTEM') as actor_name,
    u.email::text as actor_email,
    al.action, al.entity_type, al.entity_id,
    al.before, al.after, al.reason, al.created_at
  from public.audit_logs al
  left join public.clubs c on c.id = al.club_id
  left join public.profiles p on p.user_id = al.actor_id
  left join auth.users u on u.id = al.actor_id
  where (p_actor_id is null or al.actor_id = p_actor_id)
    and (p_action is null or al.action = p_action)
    and (p_entity_type is null or al.entity_type = p_entity_type)
    and (p_club_id is null or al.club_id = p_club_id)
    and (p_from is null or al.created_at >= p_from)
    and (p_to is null or al.created_at <= p_to)
  order by al.created_at desc
  limit p_limit offset p_offset;
end;
$function$;

revoke all on function public.get_platform_audit_log(int, int, uuid, text, text, uuid, timestamptz, timestamptz) from public;
revoke all on function public.get_platform_audit_log(int, int, uuid, text, text, uuid, timestamptz, timestamptz) from anon;
grant execute on function public.get_platform_audit_log(int, int, uuid, text, text, uuid, timestamptz, timestamptz) to authenticated;
